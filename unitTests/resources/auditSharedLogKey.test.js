require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// An origin's explicit timestamps can give unrelated transactions one log key. The keyed audit lookup
// (`auditStore.get(key, tableId, recordId, nodeId)`) must still find the record's entry when another
// transaction at that key comes first in the log, and must never answer with an entry at another key.
describe('Keyed audit lookup when transactions share a log key', () => {
	let Shared, Other;
	let nextId = 1;
	const newId = () => nextId++;

	before(function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		Shared = table({
			table: 'SharedLogKey',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }],
			audit: true,
		});
		Other = table({
			table: 'SharedLogKeyOther',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	});

	beforeEach(function () {
		if (isLMDB) this.skip();
	});

	// far enough ahead that the origin-closed floor admits the key unchanged
	const futureKey = (offset = 0) => Date.now() + 60_000 + offset;
	const lookup = (key, id, nodeId = 0, Resource = Shared) => Resource.auditStore.get(key, Resource.tableId, id, nodeId);
	function transactionsAt(key) {
		const transactions = new Set();
		for (const entry of Shared.auditStore.getRange({ start: key, end: key + 1, log: 0 }))
			if (entry.txnLogKey === key) transactions.add(`${entry.tableId}:${entry.recordId}`);
		return transactions.size;
	}

	it('finds a record when an unrelated transaction earlier in the log has the same key', async () => {
		const key = futureKey();
		const [first, between, second] = [newId(), newId(), newId()];
		await Shared.put(first, { name: 'first' }, { timestamp: key });
		await Shared.put(between, { name: 'between' });
		await Shared.put(second, { name: 'second' }, { timestamp: key });
		assert.strictEqual(transactionsAt(key), 2, 'two transactions share the key');

		const entry = lookup(key, second);
		assert.strictEqual(entry?.recordId, second);
		assert.strictEqual(entry.txnLogKey, key);
		assert.strictEqual(entry.tableId, Shared.tableId);
		assert.strictEqual(entry.getValue(Shared.primaryStore).name, 'second');
		assert.strictEqual(lookup(key, first)?.recordId, first);
		assert.strictEqual(lookup(key, second, undefined)?.recordId, second, 'across every origin log');
	});

	it('finds it past an intervening transaction at a higher key', async () => {
		const key = futureKey();
		const [first, between, second] = [newId(), newId(), newId()];
		await Shared.put(first, { name: 'first' }, { timestamp: key });
		await Shared.put(between, { name: 'between' }, { timestamp: key + 500 });
		await Shared.put(second, { name: 'second' }, { timestamp: key });
		assert.strictEqual(lookup(key, second)?.recordId, second);
	});

	it("never answers with the record's entry at a later key", async () => {
		const key = futureKey();
		const [first, record] = [newId(), newId()];
		await Shared.put(record, { name: 'original' });
		await Shared.put(first, { name: 'first' }, { timestamp: key });
		await Shared.patch(record, { name: 'later' }, { timestamp: key + 20 });
		assert.strictEqual(lookup(key, record), undefined, 'no entry for the record at the key');

		await Shared.patch(record, { count: 5 }, { timestamp: key });
		const entry = lookup(key, record);
		assert.strictEqual(entry?.txnLogKey, key);
		assert.strictEqual(entry.getValue(Shared.primaryStore).count, 5);
		assert.strictEqual(lookup(key + 20, record)?.txnLogKey, key + 20);
	});

	it('misses a record absent at a used key, a key no transaction used, and another table or log', async () => {
		const key = futureKey();
		const [first, between, second] = [newId(), newId(), newId()];
		await Shared.put(first, { name: 'first' }, { timestamp: key });
		await Shared.put(between, { name: 'between' });
		await Other.put(second, { name: 'same id, other table' }, { timestamp: key });
		assert.strictEqual(lookup(key, second), undefined);
		assert.strictEqual(lookup(key, second, 0, Other)?.recordId, second);
		assert.strictEqual(lookup(key + 1, first), undefined);
		assert.strictEqual(lookup(key, first, 99), undefined, 'a node id with no log');
	});

	it('matches only the exact key, fractional or not', async () => {
		const key = futureKey(0.25);
		const [first, between, second, successor] = [newId(), newId(), newId(), newId()];
		await Shared.put(first, { name: 'first' }, { timestamp: key });
		await Shared.put(between, { name: 'between' });
		const next = new Float64Array([key]);
		new BigInt64Array(next.buffer)[0]++;
		await Shared.put(successor, { name: 'successor' }, { timestamp: next[0] });
		await Shared.put(second, { name: 'second' }, { timestamp: key });
		assert.strictEqual(lookup(key, second)?.recordId, second);
		assert.strictEqual(lookup(key, successor), undefined);
		assert.strictEqual(lookup(next[0], successor)?.recordId, successor);
	});

	it('keeps the newer field when an older patch lands after a shared-key transaction', async () => {
		const id = newId();
		await Shared.put(id, { name: 'original', count: 0 });
		const base = futureKey();
		await Shared.patch(newId(), { name: 'unrelated' }, { timestamp: base + 80 });
		await Shared.put(newId(), { name: 'between' });
		await Shared.patch(id, { name: 'newer' }, { timestamp: base + 80 });
		await Shared.patch(id, { name: 'older', count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });

		const record = await Shared.get(id);
		assert.strictEqual(record.name, 'newer');
		assert.strictEqual(record.count, 1);
		assert.ok(Shared.primaryStore.getEntry(id).additionalAuditRefs?.length, 'the out-of-order write left a ref');
	});

	it('applies a re-delivered additive patch at a shared key once', async () => {
		const id = newId();
		await Shared.put(id, { name: 'original', count: 0 });
		const base = futureKey();
		await Shared.patch(id, { name: 'head' }, { timestamp: base + 80 });
		await Shared.patch(newId(), { name: 'unrelated' }, { timestamp: base + 40 });
		await Shared.put(newId(), { name: 'between' });
		await Shared.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });
		// an in-order write drops the record's refs, so only the log can recognize the re-delivery
		await Shared.patch(id, { name: 'latest' }, { timestamp: base + 100 });
		assert.strictEqual(Shared.primaryStore.getEntry(id).additionalAuditRefs, undefined);

		await Shared.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });
		const record = await Shared.get(id);
		assert.strictEqual(record.count, 1);
		assert.strictEqual(record.name, 'latest');
	});
});
