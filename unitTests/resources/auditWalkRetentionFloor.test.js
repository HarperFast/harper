require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { raiseAuditFloor, getAuditFloor } = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DAY = 86400 * 1000;
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');

// harper#2642: the out-of-order reconciliation walk follows the record's audit chain looking for an
// entry at or below the incoming write's version. Below the database's audit floor no such entry is
// accounted for, so the walk always runs the whole retained chain — an end-of-log scan per step on
// RocksDB — to an outcome the floor already determines. These tests assert the walk is not entered
// below the floor, that the one contribution which survives (commutative ops) still does and is not
// applied twice on a re-delivery, and that the walk's head lookup resolves to a single log.
describe('Out-of-order audit walk retention floor (harper#2642)', () => {
	// Every `key` the keyed dedup and the walk look up, plus the `log` each exactStart range was
	// pinned to. The walk is the only thing in this block that looks up the EXISTING chain's keys,
	// so the head's key appearing here means the walk ran.
	function spyAuditStore(auditStore) {
		const getSyncKeys = [];
		const exactStartRanges = [];
		const origGetSync = auditStore.getSync.bind(auditStore);
		const origGetRange = auditStore.getRange.bind(auditStore);
		auditStore.getSync = function (key, ...rest) {
			getSyncKeys.push(key);
			return origGetSync(key, ...rest);
		};
		auditStore.getRange = function (options, ...rest) {
			if (options?.exactStart) exactStartRanges.push({ start: options.start, log: options.log });
			return origGetRange(options, ...rest);
		};
		return {
			getSyncKeys,
			exactStartRanges,
			restore() {
				auditStore.getSync = origGetSync;
				auditStore.getRange = origGetRange;
			},
		};
	}

	// The floor is database-scoped, so a test that moves it must not decide what another starts from.
	function tableInOwnDatabase(name) {
		return table({
			table: name,
			database: `auditWalkFloor_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }, { name: 'extra' }],
			audit: true,
		});
	}

	/** A record with a two-entry audit chain, and the log key of its head. */
	async function withHead(T, id, record = { name: 'newer' }) {
		await T.put(id, { name: 'original' });
		const headKey = Date.now() + 1000;
		await T.patch(id, record, { timestamp: headKey });
		return headKey;
	}

	async function applyAndSpy(T, apply) {
		const spy = spyAuditStore(T.auditStore);
		try {
			await apply();
		} finally {
			spy.restore();
		}
		return spy;
	}

	before(function () {
		if (isLMDB) return; // RocksDB-only: LMDB's audit store is an exact O(log n) point read with no purge floor
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('does not enter the walk for a write below the audit floor', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('NotEntered');
		const headKey = await withHead(T, 'below');
		raiseAuditFloor(T.auditStore, Date.now());

		const spy = await applyAndSpy(T, () => T.put('below', { name: 'stale' }, { timestamp: Date.now() - 30 * DAY }));

		assert.ok(
			!spy.getSyncKeys.includes(headKey),
			`the walk must not look up the existing chain below the floor; got ${spy.getSyncKeys}`
		);
		// Same outcome the walk reaches when it finds a newer full write, without paying for it.
		assert.equal((await T.get('below')).name, 'newer');
	});

	it('still enters the walk for a write within the audit floor', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('StillEntered');
		const headKey = await withHead(T, 'within');

		// Older than the head, newer than the floor (which a fresh database bootstraps to its open time).
		const spy = await applyAndSpy(T, () => T.patch('within', { count: 7 }, { timestamp: headKey - 10 }));

		assert.ok(
			spy.getSyncKeys.includes(headKey),
			`the walk must still look up the existing chain within the floor; got ${spy.getSyncKeys}`
		);
		assert.equal((await T.get('within')).count, 7, 'in-retention reconciliation is unchanged');
	});

	it('still enters the walk when the floor is unknown', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('UnknownFloor');
		const headKey = await withHead(T, 'unknown');
		// An unreadable floor reads as Infinity, which every other consumer treats as "nothing is safe".
		// Here the same value has to mean "cannot decide", or it would discard every out-of-order write.
		T.auditStore.rootStore.removeSync(AUDIT_FLOOR_KEY);
		await T.auditStore.remove(AUDIT_FLOOR_KEY);
		assert.equal(getAuditFloor(T.auditStore), Infinity, 'precondition: the floor reads as unknown');

		const spy = await applyAndSpy(T, () => T.patch('unknown', { count: 3 }, { timestamp: Date.now() - 30 * DAY }));

		assert.ok(
			spy.getSyncKeys.includes(headKey),
			`an unknown floor must fall through to the walk; got ${spy.getSyncKeys}`
		);
	});

	it('applies a commutative op that arrives below the floor', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('CommutativeOp');
		await T.put('op', { name: 'newer', count: 5 });
		raiseAuditFloor(T.auditStore, Date.now());

		await T.patch('op', { count: { __op__: 'add', value: 1 } }, { timestamp: Date.now() - 30 * DAY });

		const record = await T.get('op');
		assert.equal(record.count, 6, 'the increment is order-independent and must survive the short-circuit');
		assert.equal(record.name, 'newer');
	});

	it('applies a re-delivered below-floor commutative op only once', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('ReDelivered');
		await T.put('twice', { name: 'newer', count: 5 });
		raiseAuditFloor(T.auditStore, Date.now());

		// Identical (version, node): the audit ref the short-circuit records is what the read-your-writes
		// additionalAuditRefs check matches on the second delivery.
		const staleVersion = Date.now() - 30 * DAY;
		await T.patch('twice', { count: { __op__: 'add', value: 1 } }, { timestamp: staleVersion });
		await T.patch('twice', { count: { __op__: 'add', value: 1 } }, { timestamp: staleVersion });

		assert.equal((await T.get('twice')).count, 6, 'a re-delivery must not double-apply the increment');
	});

	it('contributes no plain field from below the floor, whether or not the head carries it', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('PlainFields');
		await T.put('plain', { name: 'newer' });
		raiseAuditFloor(T.auditStore, Date.now());

		await T.patch('plain', { name: 'should-lose', extra: 7 }, { timestamp: Date.now() - 30 * DAY });

		const record = await T.get('plain');
		assert.equal(record.name, 'newer', 'a field the head carries is not overwritten');
		// `extra` is absent from the head because the newer full put did not carry it — which a head
		// record cannot tell apart from "no write ever set this key", so neither may be resurrected.
		assert.equal(record.extra, undefined, 'a field the head lacks is not resurrected either');
	});

	it('pins the walk head lookup to one log and leaves an unrecorded predecessor aggregating', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('HeadLog');
		const headKey = await withHead(T, 'logs');

		const spy = await applyAndSpy(T, () => T.patch('logs', { count: 1 }, { timestamp: headKey - 10 }));

		const headLookup = spy.exactStartRanges.find((range) => range.start === headKey);
		assert.ok(headLookup, `the walk should look up the head; got ${JSON.stringify(spy.exactStartRanges)}`);
		// `log: undefined` means "aggregate over every per-origin log", which is what pegged the field
		// receivers. A local head resolves to log 0.
		assert.strictEqual(headLookup.log, 0, 'the head lookup must name the local log, not aggregate');
		// The step after it follows `previousNodeId`, which is never encoded, so its log is genuinely
		// unknown and must keep aggregating — moving the `?? 0` to the lookup call site would send it to
		// the local log alone and truncate a cross-origin chain.
		assert.ok(
			spy.exactStartRanges.some((range) => range.start !== headKey && range.log === undefined),
			`a predecessor step must still aggregate; got ${JSON.stringify(spy.exactStartRanges)}`
		);
	});
});
