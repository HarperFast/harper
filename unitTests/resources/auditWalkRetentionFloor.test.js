require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const {
	raiseAuditFloor,
	getAuditFloor,
	purgeAgedLogs,
	setAuditRetention,
	auditRetention,
} = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DAY = 86400 * 1000;
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');

// harper#2642. The walk is not entered below the audit floor; the one contribution that survives it
// (commutative ops) still applies and is not applied twice on a re-delivery; the head lookup resolves
// to a single log.
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

	let originalRetention;

	before(function () {
		if (isLMDB) return; // RocksDB-only: LMDB's audit store is an exact O(log n) point read with no purge floor
		setupTestDBPath();
		setMainIsWorker(true);
		originalRetention = auditRetention;
	});

	after(function () {
		// both arguments: restoring only the retention leaves every audit store opened later in this
		// mocha process looping on the module-global default cleanup delay
		if (!isLMDB) setAuditRetention(originalRetention, 10_000);
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

	it('reads the floor a real retention purge records, not only an injected one', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('PurgedFloor');
		const headKey = await withHead(T, 'purged');
		// The production path: purgeAgedLogs raises the floor to Date.now() - auditRetention before asking
		// the native purge to drop anything. Everything above is well inside a 1ms retention.
		setAuditRetention(1);
		try {
			purgeAgedLogs(T.auditStore.rootStore);
		} finally {
			setAuditRetention(originalRetention, 10_000);
		}
		assert.ok(Number.isFinite(getAuditFloor(T.auditStore)), 'precondition: the purge recorded a floor');

		const spy = await applyAndSpy(T, () => T.put('purged', { name: 'stale' }, { timestamp: Date.now() - 30 * DAY }));

		assert.ok(
			!spy.getSyncKeys.includes(headKey),
			`the walk must not run below a purge-recorded floor; got ${spy.getSyncKeys}`
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

	// The receive path: the apply transaction commits under the ORIGIN's log key while the write stores
	// the origin's record version, so the two clocks differ (harper#2412). A re-delivery of the same
	// origin event repeats both, which is what the below-floor audit ref is matched on.
	function applyFromOrigin(T, id, record, { logKey, version, nodeId = 3, fullUpdate = false }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			return resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version });
		});
	}

	it('applies a re-delivered below-floor op once when the record and log clocks differ', async function () {
		if (isLMDB) return this.skip();
		const T = tableInOwnDatabase('ReDeliveredApply');
		await T.put('origin', { name: 'newer', count: 5 });
		raiseAuditFloor(T.auditStore, Date.now());

		// version below the floor, log key above it: the walk still cannot reach the version, and the
		// guard must key on the log key the origin repeats rather than on anything receiver-local.
		const version = Date.now() - 30 * DAY;
		const logKey = Date.now() + 1;
		const event = { count: { __op__: 'add', value: 1 } };
		await applyFromOrigin(T, 'origin', event, { logKey, version });
		assert.equal((await T.get('origin')).count, 6, 'the first delivery applies');

		await applyFromOrigin(T, 'origin', event, { logKey, version });
		assert.equal((await T.get('origin')).count, 6, 'the re-delivered origin event must not apply twice');
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

	// The record encoder reserves its metadata prefix through msgpackr's RESERVE_START_SPACE option,
	// whose byte count is the LOW BYTE of the option word, so a prefix over 255 bytes wraps and the
	// record is written with a reserved size neither side agrees on. Each out-of-order write applied to
	// a record appends one audit ref (12 bytes) and only an in-order write clears them, so ~19 of them
	// to one record used to cross it: the record decoded as empty, later writes rebuilt it from
	// nothing, and everything it held was gone. Both the walk and the below-floor short-circuit append
	// refs, so both are pinned here. (harper#2642)
	describe('persisted audit-ref cardinality', () => {
		async function applyOps(T, id, first, count) {
			for (let i = 0; i < count; i++) {
				await applyFromOrigin(T, id, { count: { __op__: 'add', value: 1 } }, { logKey: first + i, version: first + i });
			}
			return T.primaryStore.getEntry(id);
		}

		it('survives more out-of-order applies than the encoder prefix can hold, on the walk path', async function () {
			if (isLMDB) return this.skip();
			const T = tableInOwnDatabase('RefCardinalityWalk');
			const anchor = Date.now();
			await T.put('many', { name: 'newer', count: 0 });
			await T.patch('many', { name: 'head' }, { timestamp: anchor + 100_000 });

			// Older than the head but above the floor, so every apply goes through the reconciliation walk.
			const entry = await applyOps(T, 'many', anchor + 1000, 40);

			assert.ok(
				entry.additionalAuditRefs.length < 20,
				`ref list must stay bounded; got ${entry.additionalAuditRefs?.length}`
			);
			assert.deepEqual(await T.get('many'), { id: 'many', name: 'head', count: 40 });
		});

		it('survives the same volume through the below-floor short-circuit', async function () {
			if (isLMDB) return this.skip();
			const T = tableInOwnDatabase('RefCardinalityFloor');
			await T.put('many', { name: 'newer', count: 0 });
			raiseAuditFloor(T.auditStore, Date.now());

			const first = Date.now() - 30 * DAY;
			const entry = await applyOps(T, 'many', first, 40);

			assert.ok(
				entry.additionalAuditRefs.length < 20,
				`ref list must stay bounded; got ${entry.additionalAuditRefs?.length}`
			);
			assert.deepEqual(await T.get('many'), { id: 'many', name: 'newer', count: 40 });
			// The bound drops the middle, never the newest: that entry is the only thing standing between a
			// re-delivery of the last event and a second increment, since the walk no longer runs.
			const newest = first + 39;
			assert.ok(
				entry.additionalAuditRefs.some((ref) => ref.version === newest),
				`the newest identity must survive the bound; got ${JSON.stringify(entry.additionalAuditRefs)}`
			);
			await applyFromOrigin(T, 'many', { count: { __op__: 'add', value: 1 } }, { logKey: newest, version: newest });
			assert.equal((await T.get('many')).count, 40, 'a re-delivery at the bound must not apply twice');
		});
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
