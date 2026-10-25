require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { publishOriginFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const {
	createAuditEntry,
	readAuditEntry,
	raiseAuditFloor,
	HAS_ADDITIONAL_AUDIT_REFS,
} = require('#src/resources/auditStore');
const { RECEIVED_IDENTITY_REF } = require('#src/resources/RecordEncoder');
const { Transaction } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// A record's audit references are log keys (its audit head, out-of-order branch heads) or received
// identities (what a re-delivery carries when it is not the appended key). These cases make values of
// the two kinds bit-equal, so only the stored kind can tell them apart.
describe('Audit references state their kind', () => {
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }];
	let databaseCount = 0;
	const tableInOwnDatabase = () =>
		table({ table: 'AuditRefKinds', database: `auditRefKinds${++databaseCount}`, attributes, audit: true });

	before(function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(function () {
		if (isLMDB) this.skip();
	});

	function ulpsAbove(value, count) {
		const scratch = new Float64Array([value]);
		new BigInt64Array(scratch.buffer)[0] += BigInt(count);
		return scratch[0];
	}
	function entriesFor(T, id, log = 0) {
		const entries = [];
		for (const entry of T.auditStore.getRange({ start: 1, log }))
			if (entry.tableId === T.tableId && entry.recordId === id) entries.push(entry);
		return entries;
	}
	function applyFromOrigin(T, id, record, { logKey, version, nodeId, fullUpdate = false }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			return resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version });
		});
	}

	it('a minted key equal to an earlier explicit version on the record is not that write’s receipt', async () => {
		const T = tableInOwnDatabase();
		// strict issuance: each mint is the next ulp above the floor, so K(n) is the nth key minted
		const floor = Date.now() + 600_000;
		publishOriginFloor(T.primaryStore.rootStore, floor);
		const K = (n) => ulpsAbove(floor, n);

		await T.put('counter', { name: 'seed', count: 0 });
		await T.patch('counter', { name: 'head' }, { timestamp: K(7) });
		for (let n = 3; n <= 6; n++) await T.put(`other-${n}`, { name: 'unrelated' });
		assert.deepEqual(
			[entriesFor(T, 'counter').map((entry) => entry.txnLogKey), entriesFor(T, 'other-6')[0].txnLogKey],
			[[K(1), K(2)], K(6)],
			'the next mint is K(7), the head patch’s version'
		);

		await T.patch('counter', { count: { __op__: 'add', value: 1 } }, { timestamp: K(6) });
		assert.deepEqual(await T.get('counter'), { id: 'counter', name: 'head', count: 1 });
		const patch = entriesFor(T, 'counter').find((entry) => entry.version === K(6));
		assert.equal(patch?.txnLogKey, K(7));
	});

	it('a retried save keeps its lock stamp with a distinct local log key', async () => {
		const T = tableInOwnDatabase();
		const floor = Date.now() + 600_000;
		publishOriginFloor(T.primaryStore.rootStore, floor);
		const K = (n) => ulpsAbove(floor, n);
		await T.put('held', { name: 'seed' });
		const targetDb = T.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let conflicted;
		let holder;
		try {
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db === targetDb && conflicted === undefined) {
					conflicted = this.id;
					throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY', hasLog: true });
				}
				return originalCommit.apply(this, args);
			};
			// The holder's first stamp is K(2); local log keys remain separately minted.
			holder = await T.lock('held', { hold: true, lease: 15_000 }, { timestamp: K(2) });
			holder.set('name', 'first');
			await holder.save();
			assert.ok(conflicted, 'the first save must have been retried');
			const first = T.primaryStore.getEntry('held');
			assert.deepEqual([first.version, entriesFor(T, 'held').at(-1).txnLogKey], [K(2), K(3)]);
			holder.set('name', 'second');
			await holder.save();
			const second = T.primaryStore.getEntry('held');
			assert.equal(second.value.name, 'second');
			assert(second.version > first.version, 'each save of a holder steps the record version');
		} finally {
			Transaction.prototype.commit = originalCommit;
			await holder?.unlock();
		}
	});

	it('walks a branch whose log key equals the record version', async () => {
		const T = tableInOwnDatabase();
		const origin = getIdOfRemoteNode('audit-ref-kinds-origin', T.auditStore);
		const B = Date.now() + 3_600_000;
		await applyFromOrigin(T, 'r', { id: 'r', count: 0 }, { logKey: B, version: B, nodeId: origin, fullUpdate: true });
		await applyFromOrigin(T, 'r', { name: 'A' }, { logKey: B + 100, version: B + 200, nodeId: origin });
		await applyFromOrigin(T, 'r', { count: 1 }, { logKey: B + 200, version: B + 100, nodeId: origin });
		assert.equal(T.primaryStore.getEntry('r').version, B + 200);

		await applyFromOrigin(T, 'r', { count: 2 }, { logKey: B + 300, version: B + 50, nodeId: origin });
		const record = await T.get('r');
		assert.equal(record.name, 'A');
		assert.equal(record.count, 1, 'the newer count on the B+200 branch wins');
	});

	it('stores an identity as its own kind and keeps it out of the audit log', async () => {
		const T = tableInOwnDatabase();
		await T.put('r', { name: 'seed' });
		const version = Date.now() + 60_000;
		await T.patch('r', { name: 'explicit' }, { timestamp: version });
		const [, explicit] = entriesFor(T, 'r');
		const record = T.primaryStore.getEntry('r');
		assert.deepEqual(record.additionalAuditRefs, [{ version: explicit.txnLogKey, nodeId: 0 }]);
		assert.deepEqual(record.receivedIdentityRefs, [{ version, nodeId: 0 }]);

		await T.patch('r', { count: 1 }, { timestamp: version - 1000 });
		const older = entriesFor(T, 'r').find((entry) => entry.version === version - 1000);
		assert.deepEqual(older.previousAdditionalAuditRefs, [{ version: explicit.txnLogKey, nodeId: 0 }]);
		assert.deepEqual(T.primaryStore.getEntry('r').receivedIdentityRefs, [
			{ version, nodeId: 0 },
			{ version: version - 1000, nodeId: 0 },
		]);
	});

	it('reads an identity a build without the kind bit copied into an audit entry as no ref', () => {
		const now = Date.now();
		const encoded = createAuditEntry({
			version: now,
			previousVersion: now - 2000,
			tableId: 1,
			recordId: 'r',
			nodeId: 0,
			type: 'put',
			extendedType: HAS_ADDITIONAL_AUDIT_REFS,
			previousAdditionalAuditRefs: [
				{ version: now - 1000, nodeId: 2 },
				{ version: now - 2000, nodeId: RECEIVED_IDENTITY_REF + 2 },
			],
		});
		assert.deepEqual(readAuditEntry(encoded).previousAdditionalAuditRefs, [{ version: now - 1000, nodeId: 2 }]);
	});

	it('keeps every remote receipt when identities fill the persisted ref budget', async () => {
		const T = tableInOwnDatabase();
		const origin = getIdOfRemoteNode('audit-ref-kinds-budget', T.auditStore);
		await T.put('many', { name: 'newer', count: 0 });
		const stale = Date.now() - 86_400_000;
		// the origin's log starts above the stale keys, so no keyed lookup reaches them: only the record's refs can
		await applyFromOrigin(T, 'other', { id: 'other' }, { logKey: stale + 1000, version: stale + 1000, nodeId: origin });
		raiseAuditFloor(T.auditStore, Date.now());
		const increment = { count: { __op__: 'add', value: 1 } };
		const older = { logKey: stale - 100, version: stale - 100, nodeId: origin };
		const newer = { logKey: stale, version: stale, nodeId: origin };
		await applyFromOrigin(T, 'many', increment, older);
		for (let n = 1; n <= 30; n++) await T.patch('many', increment, { timestamp: stale - n });
		await applyFromOrigin(T, 'many', increment, newer);
		const entry = T.primaryStore.getEntry('many');
		assert.ok(entry.additionalAuditRefs.length + entry.receivedIdentityRefs.length < 20, 'the budget bound held');
		assert.equal(entry.receivedIdentityRefs.at(-1).version, stale - 30);

		await applyFromOrigin(T, 'many', increment, older);
		await applyFromOrigin(T, 'many', increment, newer);
		assert.equal((await T.get('many')).count, 32, 'each re-delivery matched its receipt');
	});
});
