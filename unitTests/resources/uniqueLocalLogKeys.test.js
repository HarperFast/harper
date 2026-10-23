require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { publishOriginFloor } = require('#src/resources/originClosedFloor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Every local-origin transaction has a unique log key', () => {
	let Tbl;
	let nextId = 1;
	const newId = () => nextId++;
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }];

	before(function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({ table: 'UniqueLocalLogKeys', database: 'uniqueLocalLogKeys', attributes, audit: true });
	});

	beforeEach(function () {
		if (isLMDB) this.skip();
	});

	// ahead of the clock: the floor used to admit such a value unchanged as the key
	const futureTimestamp = (offset = 0) => Date.now() + 1000 + offset;
	const lookup = (key, id, nodeId = 0, Resource = Tbl) => Resource.auditStore.get(key, Resource.tableId, id, nodeId);
	function entriesFor(id, Resource = Tbl) {
		const entries = [];
		for (const entry of Resource.auditStore.getRange({ start: 1, log: 0 }))
			if (entry.tableId === Resource.tableId && entry.recordId === id) entries.push(entry);
		return entries;
	}
	function assertDistinctKeys(entries) {
		const keys = entries.map((entry) => entry.txnLogKey);
		assert.equal(new Set(keys).size, keys.length, `log keys repeat: ${keys.join(', ')}`);
	}
	function ulpsAbove(value, count) {
		const scratch = new Float64Array([value]);
		new BigInt64Array(scratch.buffer)[0] += BigInt(count);
		return scratch[0];
	}

	it('two writes with one explicit timestamp take distinct keys and keep the timestamp as their version', async () => {
		const timestamp = futureTimestamp();
		const [first, between, second] = [newId(), newId(), newId()];
		await Tbl.put(first, { name: 'first' }, { timestamp });
		await Tbl.put(between, { name: 'between' });
		await Tbl.put(second, { name: 'second' }, { timestamp });
		const [firstEntry] = entriesFor(first);
		const [secondEntry] = entriesFor(second);
		assertDistinctKeys([firstEntry, ...entriesFor(between), secondEntry]);
		for (const [id, entry, name] of [
			[first, firstEntry, 'first'],
			[second, secondEntry, 'second'],
		]) {
			assert.equal(entry.version, timestamp, 'the explicit value is the record version');
			assert.notEqual(entry.txnLogKey, timestamp, 'the explicit value is never the log key');
			const record = Tbl.primaryStore.getEntry(id);
			assert.equal(record.version, timestamp);
			assert(
				record.additionalAuditRefs?.some((ref) => ref.version === entry.txnLogKey),
				'the record points at its audit head by log key'
			);
			const found = lookup(entry.txnLogKey, id);
			assert.equal(found?.recordId, id, 'the keyed lookup addresses the entry by its own key');
			assert.equal(found.getValue(Tbl.primaryStore).name, name);
			assert.equal(lookup(entry.txnLogKey, id, undefined)?.recordId, id, 'any log');
		}
	});

	it('history and the chain resolve a write whose key differs from its version', async () => {
		const id = newId();
		await Tbl.put(id, { name: 'v1' });
		const timestamp = futureTimestamp();
		await Tbl.patch(id, { name: 'v2' }, { timestamp });
		const [v1, v2] = entriesFor(id);
		assertDistinctKeys([v1, v2]);
		assert.equal(v2.version, timestamp);
		assert(v2.txnLogKey > v1.txnLogKey, 'the log orders by commit, not by the explicit value');
		const history = await Tbl.getHistoryOfRecord(id);
		assert.deepEqual(
			history.map((event) => [event.type, event.version, event.localTime]),
			[
				['put', v1.version, v1.txnLogKey],
				['patch', timestamp, v2.txnLogKey],
			]
		);
		assert.equal(history[1].value.name, 'v2');
	});

	it('keeps the newer field when an older patch lands after a transaction that shares its timestamp', async () => {
		const id = newId();
		await Tbl.put(id, { name: 'original', count: 0 });
		const base = futureTimestamp();
		await Tbl.patch(newId(), { name: 'unrelated' }, { timestamp: base + 80 });
		await Tbl.put(newId(), { name: 'between' });
		await Tbl.patch(id, { name: 'newer' }, { timestamp: base + 80 });
		await Tbl.patch(id, { name: 'older', count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });

		const record = await Tbl.get(id);
		assert.equal(record.name, 'newer');
		assert.equal(record.count, 1);
		assert.ok(Tbl.primaryStore.getEntry(id).additionalAuditRefs?.length, 'the out-of-order write left a ref');
	});

	it('applies a re-delivered additive patch once when another transaction shares its timestamp', async () => {
		const id = newId();
		await Tbl.put(id, { name: 'original', count: 0 });
		const base = futureTimestamp();
		await Tbl.patch(id, { name: 'head' }, { timestamp: base + 80 });
		await Tbl.patch(newId(), { name: 'unrelated' }, { timestamp: base + 40 });
		await Tbl.put(newId(), { name: 'between' });
		await Tbl.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });
		// an in-order write drops the record's refs, so only the log can recognize the re-delivery
		await Tbl.patch(id, { name: 'latest' }, { timestamp: base + 100 });

		await Tbl.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: base + 40 });
		const record = await Tbl.get(id);
		assert.equal(record.count, 1);
		assert.equal(record.name, 'latest');
	});

	it('resequences out-of-order patches when the head shares its timestamp with another record (transaction.test.js:507)', async () => {
		const base = futureTimestamp();
		const [other, between, id] = [newId(), newId(), newId()];
		await Tbl.put(other, { name: 'other' });
		await Tbl.patch(other, { name: 'other-newer' }, { timestamp: base + 100 });
		await Tbl.put(between, { name: 'between' });
		await Tbl.put(id, { name: 'original', count: 0 });
		// apply order: update4, update2, update1, update3 — with update4 at the other record's timestamp
		await Tbl.patch(id, { name: 'update4', prop4: true }, { timestamp: base + 100 });
		await Tbl.patch(id, { prop2: true }, { timestamp: base + 40 });
		await Tbl.patch(id, { prop1: true, count: { __op__: 'add', value: 1 } }, { timestamp: base + 20 });
		await Tbl.patch(id, { prop3: true, count: { __op__: 'add', value: 1 } }, { timestamp: base + 60 });

		const record = await Tbl.get(id);
		assert.equal(record.name, 'update4');
		for (const prop of ['prop1', 'prop2', 'prop3', 'prop4'])
			assert.equal(record[prop], true, `${prop} should be present`);
		assert.equal(record.count, 2, 'both increments applied once');
		assert(Tbl.primaryStore.getEntry(id).additionalAuditRefs, 'additional audit refs exist for complex resequencing');
		assertDistinctKeys([...entriesFor(other), ...entriesFor(between), ...entriesFor(id)]);
	});

	it('a minted key never lands on an explicit timestamp issued earlier', async () => {
		const Floored = table({
			table: 'UniqueLocalLogKeysFloored',
			database: 'uniqueLocalLogKeysFloored',
			attributes,
			audit: true,
		});
		// a future floor puts issuance in strict mode: minted keys come one ulp at a time above the ratchet,
		// so an explicit value a few ulps above it is exactly where a later mint lands
		const floor = Date.now() + 600_000;
		publishOriginFloor(Floored.primaryStore.rootStore, floor);
		const explicit = ulpsAbove(floor, 6);
		const ids = Array.from({ length: 12 }, newId);
		await Floored.put(ids[0], { name: 'explicit' }, { timestamp: explicit });
		for (let n = 1; n < ids.length; n++) await Floored.put(ids[n], { name: `minted-${n}` });

		const entries = ids.map((id) => entriesFor(id, Floored)[0]);
		assertDistinctKeys(entries);
		assert.equal(entries[0].version, explicit);
		for (const [index, entry] of entries.entries())
			assert.equal(lookup(entry.txnLogKey, ids[index], 0, Floored)?.recordId, ids[index], `entry ${index} by its key`);
	});
});
