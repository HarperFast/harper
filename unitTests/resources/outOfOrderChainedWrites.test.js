// An out-of-order transaction (older than the stored version) that writes one key twice must apply
// both writes. On RocksDB the second write reloads the entry the first staged, which carries the
// first write's out-of-order audit ref under the shared transaction log key; the re-delivery dedup
// must not read that ref as proof that this transaction was already applied.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { raiseAuditFloor } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const add = (value) => ({ __op__: 'add', value });

describe('Out-of-order transaction with chained writes to one key', function () {
	this.timeout(10000);
	let T, newer, older;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'OutOfOrderChain',
			database: 'outOfOrderChain',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'a' },
				{ name: 'b' },
				{ name: 'c', indexed: true },
				{ name: 'count' },
			],
			audit: true,
		});
		if (T.indexingOperation) await T.indexingOperation;
		newer = getIdOfRemoteNode('chain-newer-origin', T.auditStore);
		older = getIdOfRemoteNode('chain-older-origin', T.auditStore);
	});

	// The second write also sets `c`, which the newer write owns, so this is the merge, not an overwrite.
	const chain = [
		{ a: 'from-w1', count: add(10) },
		{ b: 'from-w2', c: 'from-w2', count: add(5) },
	];
	const merged = { a: 'from-w1', b: 'from-w2', c: 'from-t2', count: 115 };

	async function record(id) {
		const { a, b, c, count } = await T.get(id);
		return { a, b, c, count };
	}

	/** A record at t0, then a newer patch at t2; t1 sits between them. Future clocks: RocksDB stamps an
	 * audit floor at open, and a write below it skips the walk. */
	async function seed(id, { replicated }) {
		const base = Date.now() + 86400000;
		const clocks = { t0: base, t1: base + 2000, t2: base + 5000 };
		await T.put(id, { a: 'init-a', b: 'init-b', c: 'init-c', count: 100 }, { timestamp: clocks.t0 });
		if (replicated) await applyFromOrigin(id, [{ c: 'from-t2' }], { version: clocks.t2, nodeId: newer });
		else await T.patch(id, { c: 'from-t2' }, { timestamp: clocks.t2 });
		return clocks;
	}

	function applyFromOrigin(id, records, { version, nodeId }, afterStage, Table = T) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			for (const record of records) {
				const resource = await Table.getResource(id, context);
				await resource._writeUpdate(id, record, false, { isNotification: true, nodeId, version });
			}
			await afterStage?.(context.transaction);
		});
	}

	function ownRefs(id, t1, Table = T) {
		const refs = Table.primaryStore.getEntry(id).additionalAuditRefs ?? [];
		return refs.filter((ref) => ref.version === t1 && ref.nodeId === older);
	}

	function auditEntries(id, nodeId) {
		let count = 0;
		for (const entry of T.auditStore.getRange({ start: 1, log: nodeId })) if (entry.recordId === id) count++;
		return count;
	}

	it('applies both patches of a local out-of-order transaction', async () => {
		const { t1 } = await seed('local', { replicated: false });
		const context = { timestamp: t1 };
		await transaction(context, async () => {
			for (const patch of chain) await T.patch('local', patch, context);
		});
		assert.deepStrictEqual(await record('local'), merged);
	});

	it('applies both patches of a replicated out-of-order transaction once, even when re-delivered', async () => {
		const { t1 } = await seed('replicated', { replicated: true });
		await applyFromOrigin('replicated', chain, { version: t1, nodeId: older });
		assert.deepStrictEqual(await record('replicated'), merged);
		// LMDB keeps no audit refs, and does not dedup an out-of-order re-delivery even of a single write.
		if (isLMDB) return;
		assert.equal(ownRefs('replicated', t1).length, 1, 'the chain leaves one ref for its one log key');

		await applyFromOrigin('replicated', chain, { version: t1, nodeId: older });
		assert.deepStrictEqual(await record('replicated'), merged, 're-delivery must not re-apply either increment');
	});

	it('keeps the index on the merged value', async () => {
		const ids = [];
		for await (const { id } of T.search({ conditions: [{ attribute: 'c', value: 'from-t2' }] })) ids.push(id);
		assert.deepStrictEqual(ids.sort(), ['local', 'replicated']);
		for await (const { id } of T.search({ conditions: [{ attribute: 'c', value: 'from-w2' }] }))
			assert.fail(`stale index entry for ${id}`);
	});

	it('applies both patches of a transaction frame through the source dispatcher, once', async function () {
		const Dispatched = table({
			table: 'OutOfOrderChainDispatched',
			database: 'outOfOrderChain',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'count' }],
			audit: true,
		});
		const id = 'dispatched';
		const base = Date.now() + 86400000;
		const [t0, t1, t2, marker] = [base, base + 2000, base + 5000, base + 6000];
		const write = (type, value, nodeId, version) => ({ type, id, value, nodeId, version });
		const frame = (timestamp, writes) => ({ type: 'transaction', timestamp, writes });
		const chainFrame = frame(
			t1,
			chain.map((patch) => write('patch', patch, older, t1))
		);
		let release;
		const held = new Promise((resolve) => (release = resolve));
		Dispatched.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					yield frame(t0, [write('put', { id, a: 'init-a', b: 'init-b', c: 'init-c', count: 100 }, newer, t0)]);
					yield frame(t2, [write('patch', { c: 'from-t2' }, newer, t2)]);
					yield chainFrame;
					// re-delivered, as a reconnect replays it (LMDB: no re-delivery dedup, see above)
					if (!isLMDB) yield chainFrame;
					yield frame(marker, [{ type: 'put', id: 'marker', value: { id: 'marker' }, nodeId: newer, version: marker }]);
					await held;
				},
			},
			{ intermediateSource: true }
		);
		try {
			await waitFor(() => Dispatched.primaryStore.getEntry('marker')?.value, {
				timeout: 5000,
				message: 'the frames should apply',
			});
			const { a, b, c, count } = await Dispatched.get(id);
			assert.deepStrictEqual({ a, b, c, count }, merged);
		} finally {
			release();
		}
	});

	it('applies the ops of both patches once when the transaction is below the audit floor', async function () {
		if (isLMDB) return this.skip();
		const Floor = table({
			table: 'OutOfOrderChainFloor',
			database: 'outOfOrderChainFloor',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'count' }],
			audit: true,
		});
		const id = 'below-floor';
		await Floor.put(id, { a: 'init-a', b: 'init-b', c: 'from-t2', count: 100 });
		raiseAuditFloor(Floor.auditStore, Date.now());
		const t1 = Date.now() - 30 * 86400000;
		// below the floor a write contributes only its commutative ops
		const expected = { a: 'init-a', b: 'init-b', c: 'from-t2', count: 115 };
		await applyFromOrigin(id, chain, { version: t1, nodeId: older }, undefined, Floor);
		let { a, b, c, count } = await Floor.get(id);
		assert.deepStrictEqual({ a, b, c, count }, expected);
		assert.equal(ownRefs(id, t1, Floor).length, 1);

		await applyFromOrigin(id, chain, { version: t1, nodeId: older }, undefined, Floor);
		({ a, b, c, count } = await Floor.get(id));
		assert.deepStrictEqual({ a, b, c, count }, expected, 're-delivery must not re-apply either increment');
	});

	describe('across a commit conflict retry', () => {
		/** Stages the whole chain, lets `concurrent` commit the same key, and returns the chain's writes. */
		async function chainAgainst(id, t1, concurrent) {
			let native, writes;
			await applyFromOrigin(id, chain, { version: t1, nodeId: older }, async (txn) => {
				writes = txn.writes.filter((write) => write.key === id);
				for (const write of writes) await txn.save(write);
				native = txn.transaction;
				await concurrent();
			});
			assert.ok(native.retries > 0, 'RocksDB must detect and retry the real conflict');
			assert.equal(writes.length, 2);
			return writes;
		}

		it('skips every member when a competing delivery committed the same chain', async function () {
			if (isLMDB) return this.skip();
			const id = 'competing';
			const { t1 } = await seed(id, { replicated: true });
			const writes = await chainAgainst(id, t1, () => applyFromOrigin(id, chain, { version: t1, nodeId: older }));
			assert.deepStrictEqual(await record(id), merged, 'the committed chain must not apply twice');
			assert.ok(
				writes.every((write) => write.skipped),
				'both writes belong to the committed duplicate'
			);
			assert.equal(ownRefs(id, t1).length, 1);
		});

		it('applies both members once after an unrelated newer write wins the conflict', async function () {
			if (isLMDB) return this.skip();
			const id = 'orphaned';
			const { t1, t2 } = await seed(id, { replicated: true });
			const writes = await chainAgainst(id, t1, () =>
				applyFromOrigin(id, [{ count: add(1) }], { version: t2 + 1000, nodeId: newer })
			);
			assert.deepStrictEqual(await record(id), { ...merged, count: 116 });
			assert.ok(
				writes.every((write) => !write.skipped),
				'the failed attempt left only its own entries'
			);
			assert.equal(auditEntries(id, older), 2, 'the retry must not append the chain again');
			assert.equal(ownRefs(id, t1).length, 1);
		});
	});
});
