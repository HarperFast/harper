const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { HistoryMemo, HistoryReader } = require('#src/resources/historyReader');
const { getRecordAtTime, readAuditFrame } = require('#src/resources/crdt');
const {
	createAuditEntry,
	readAuditEntry,
	removeAuditEntry,
	raiseAuditFloor,
	ENTRY_DATAVIEW,
} = require('#src/resources/auditStore');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
require('#src/server/serverHelpers/serverUtilities');

const lmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const database = 'bounded_history_reader';

describe('bounded history readers', function () {
	this.timeout(120_000);
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	function newTable(options = {}) {
		return table({
			database,
			table: `HistoryReader${++sequence}`,
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'name' }, { name: 'payload' }],
			...options,
		});
	}
	function entries(T) {
		return [...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.tableId === T.tableId);
	}
	function plainHistory(T, id) {
		const result = [];
		for (const entry of T.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== T.tableId || (id !== undefined && entry.recordId !== id)) continue;
			if (['evict', 'reload', 'lockRelease', 'lockBarrier'].includes(entry.type)) continue;
			result.push({
				id: entry.recordId,
				type: entry.type,
				value: entry.getValue(T.primaryStore, true, entry.txnLogKey),
			});
		}
		return result;
	}
	const values = (history) => history.map(({ id, type, value }) => ({ id, type, value }));
	function meter(T) {
		const store = T.auditStore;
		let reads = 0;
		let windows = 0;
		const originals = new Map();
		for (const name of ['get', 'getSync', 'getRange', 'getBinary']) {
			const original = store[name];
			originals.set(name, original);
			store[name] = function (...args) {
				if (name === 'getRange') {
					if (args[0]?.snapshot !== false) reads++;
					if (!args[0]?.exactStart && args[0]?.snapshot !== false) windows++;
				} else if (name === 'getBinary' || args[1] === T.tableId) reads++;
				return original.apply(this, args);
			};
		}
		return {
			get reads() {
				return reads;
			},
			get windows() {
				return windows;
			},
			close() {
				for (const [name, original] of originals) store[name] = original;
			},
		};
	}

	for (const selection of ['record', 'table', 'operation']) {
		it(`uses bounded audit reads for 300 patches (${selection})`, async () => {
			const T = newTable();
			await T.put({ id: 'a', n: 0, name: 'start' });
			for (let i = 1; i <= 300; i++) {
				if (i === 151) await delay(130);
				await T.patch('a', { n: i });
			}
			const counter = meter(T);
			try {
				let history;
				if (selection === 'record') history = await T.getHistoryOfRecord('a');
				else if (selection === 'table') history = await Array.fromAsync(T.getHistory());
				else {
					const result = await new ResourceBridge().readAuditLog({
						schema: database,
						table: T.tableName,
						search_type: 'hash_value',
						search_values: ['a'],
					});
					history = result.a.map((entry) => ({ value: entry.records[0] }));
				}
				assert.strictEqual(history.length, 301);
				assert.deepStrictEqual(
					history.map((entry) => entry.value.n),
					Array.from({ length: 301 }, (_, i) => i)
				);
				assert(counter.reads < 300 * 10, `${counter.reads} audit reads for 300 patches`);
				if (selection !== 'table') assert(counter.windows >= 2, 'the listing must cross actual log-time windows');
			} finally {
				counter.close();
			}
		});
	}

	for (const schemaDefined of [true, false]) {
		it(`matches the plain rebuild for seeded random writes (schema: ${schemaDefined})`, async () => {
			const T = newTable({ schemaDefined });
			let seed = 0x6ac491;
			const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
			for (let i = 0; i < 80; i++) {
				const id = ['a', 'b', 'c'][Math.floor(random() * 3)];
				const choice = random();
				if (choice < 0.2) await T.put({ id, n: i, name: `put-${i}`, payload: { nested: [i, null] } });
				else if (choice < 0.3) await T.delete(id);
				else if (choice < 0.35) await T.invalidate(id);
				else if (choice < 0.4) await T.publish(id, { notice: i });
				else if (choice < 0.55) await T.patch(id, { n: { __op__: 'add', value: 1 } });
				else await T.patch(id, { n: i, name: `patch-${i}`, payload: { nested: [i, `v${i}`] } });
			}
			assert.deepStrictEqual(values(await Array.fromAsync(T.getHistory())), plainHistory(T));
			for (const id of ['a', 'b', 'c'])
				assert.deepStrictEqual(values(await T.getHistoryOfRecord(id)), plainHistory(T, id));
		});
	}

	it('keeps numeric and string ids separate', async () => {
		const T = newTable();
		await T.put({ id: 1, n: 0, name: 'numeric' });
		await T.put({ id: '1', n: 10, name: 'string' });
		for (let i = 0; i < 5; i++) {
			await T.patch(1, { n: i + 1 });
			await T.patch('1', { n: 20 + i });
		}
		assert.deepStrictEqual(values(await Array.fromAsync(T.getHistory())), plainHistory(T));
	});

	it('preserves the rebuild after a schemaless attribute strip', async () => {
		const T = newTable({ schemaDefined: false });
		await T.put({ id: 'a', n: 0, name: 'removed' });
		await T.patch('a', { name: 'also removed' });
		await new ResourceBridge().dropAttribute({ schema: database, table: T.tableName, attribute: 'name' });
		await T.patch('a', { n: 2 });
		assert.strictEqual(T.primaryStore.getEntry('a').value.name, undefined);
		assert.deepStrictEqual(values(await T.getHistoryOfRecord('a')), plainHistory(T, 'a'));
		assert.deepStrictEqual(values(await Array.fromAsync(T.getHistory())), plainHistory(T));
	});

	it('keeps invalidated stub histories on the rebuild path', async () => {
		const T = newTable({
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'n' }],
		});
		await T.put({ id: 'a', n: 0, name: 'kept' });
		await T.patch('a', { n: 1 });
		await T.invalidate('a');
		await T.patch('a', { n: 2 });
		await T.patch('a', { n: 3 });
		assert.deepStrictEqual(values(await T.getHistoryOfRecord('a')), plainHistory(T, 'a'));
		assert.deepStrictEqual(values(await Array.fromAsync(T.getHistory())), plainHistory(T));
	});

	it('matches plain images after an out-of-order mapped-origin merge', async () => {
		const T = newTable();
		const origin = getIdOfRemoteNode(`history-reader-origin-${sequence}`, T.auditStore);
		const base = Date.now() + 86_400_000;
		await T.put('a', { id: 'a', n: 0 }, { timestamp: base });
		await T.patch('a', { n: 20 }, { timestamp: base + 2000 });
		const context = { source: {}, sourceApply: true, timestamp: base + 1000 };
		await transaction(context, async () => {
			const resource = await T.getResource('a', context);
			await resource._writeUpdate('a', { name: 'remote', n: 10 }, false, {
				isNotification: true,
				nodeId: origin,
				version: base + 1000,
			});
		});
		await T.patch('a', { n: 30 }, { timestamp: base + 3000 });
		assert.deepStrictEqual(values(await Array.fromAsync(T.getHistory())), plainHistory(T));
		const expected = new Map();
		for (const entry of T.auditStore.getRange({ start: 1 })) {
			if (entry.tableId === T.tableId)
				expected.set(lmdb ? entry.version : entry.txnLogKey, entry.getValue(T.primaryStore, true, entry.txnLogKey));
		}
		for (const entry of await T.getHistoryOfRecord('a'))
			assert.deepStrictEqual(entry.value, expected.get(entry.localTime));
	});

	it('preserves Date, Buffer, BigInt and nested values and isolates returned images', async () => {
		const T = newTable();
		await T.put({
			id: 'a',
			n: 0,
			payload: {
				date: new Date(123456789),
				bytes: Buffer.from('payload'),
				integer: 12345678901234567890n,
				nested: [{ value: 1 }],
			},
		});
		await T.patch('a', { n: 1 });
		await T.patch('a', { n: 2 });
		const expected = plainHistory(T);
		assert.deepStrictEqual(values(await T.getHistoryOfRecord('a')), expected);
		const reader = new HistoryReader(T.primaryStore, T.tableId, () => true);
		try {
			const patches = entries(T).filter((entry) => entry.type === 'patch');
			const first = reader.read(patches[0]);
			first.payload.bytes[0] = 0;
			first.payload.nested[0].value = 99;
			const second = reader.read(patches[1]);
			assert.deepStrictEqual(second, {
				id: 'a',
				n: 2,
				payload: {
					date: new Date(123456789),
					bytes: Buffer.from('payload'),
					integer: 12345678901234567890n,
					nested: [{ value: 1 }],
				},
			});
		} finally {
			reader.memo.close();
		}
	});

	it('keeps file-backed Blob values on the plain rebuild', async () => {
		const T = newTable({
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'blob', type: 'Blob' }],
		});
		const bytes = Buffer.alloc(25000, 7);
		await T.put({ id: 'a', n: 0, blob: new Blob([bytes]) });
		await T.patch('a', { n: 1 });
		await T.patch('a', { n: 2 });
		const history = await T.getHistoryOfRecord('a');
		assert.strictEqual(history.length, 3);
		for (const entry of history) {
			assert.strictEqual(typeof entry.value.blob.bytes, 'function');
			assert.deepStrictEqual(Buffer.from(await entry.value.blob.bytes()), bytes);
		}
	});

	for (const limits of [
		{ maxEntries: 1, maxBytes: 8 * 1024 * 1024 },
		{ maxEntries: 100, maxBytes: 64 },
	]) {
		it(`falls back within entry and byte bounds ${JSON.stringify(limits)}`, async () => {
			const T = newTable();
			await T.put({ id: 'a', n: 0, payload: 'x'.repeat(1000) });
			await T.patch('a', { n: 1 });
			await T.patch('a', { n: 2 });
			const reader = new HistoryReader(T.primaryStore, T.tableId, () => true, limits);
			try {
				for (const entry of entries(T)) {
					assert.deepStrictEqual(reader.read(entry), entry.getValue(T.primaryStore, true, entry.txnLogKey));
					assert(reader.memo.stats.entries <= limits.maxEntries);
					assert(reader.memo.stats.bytes <= limits.maxBytes);
				}
				assert.strictEqual(reader.memo.exhausted, true);
			} finally {
				reader.memo.close();
			}
			assert.strictEqual(reader.memo.stats.entries, 0);
			assert.strictEqual(reader.memo.stats.bytes, 0);
		});
	}

	it('does not retain an incomplete observed frame prefix', async function () {
		if (lmdb) this.skip();
		const T = newTable();
		await transaction(async () => {
			await T.put({ id: 'a', n: 0 });
			await T.patch('a', { n: 1 });
		});
		const frame = entries(T);
		assert.strictEqual(frame[0].endTxn, false);
		const memo = new HistoryMemo(T.primaryStore, T.tableId, {}, 'a');
		try {
			memo.beginRange();
			memo.observe(frame[0]);
			memo.finishRange();
			assert.strictEqual(memo.stats.entries, 0);
			const key = frame[0].txnLogKey;
			assert.deepStrictEqual(
				getRecordAtTime(undefined, key, T.primaryStore, T.tableId, 'a', 0, memo),
				getRecordAtTime(undefined, key, T.primaryStore, T.tableId, 'a', 0)
			);
		} finally {
			memo.close();
		}
	});

	it('does not reuse a duplicate same-key tail after endTxn', async function () {
		if (lmdb) this.skip();
		const T = newTable();
		await T.put({ id: 'a', n: 0 });
		await T.put({ id: 'a', n: 1 });
		const memo = new HistoryMemo(T.primaryStore, T.tableId, {}, 'a');
		try {
			const [first, second] = entries(T).map((entry) => memo.restore(memo.snapshot(entry)));
			assert(first.endTxn && second.endTxn);
			second.txnLogKey = first.txnLogKey;
			memo.beginRange();
			memo.observe(first);
			memo.observe(second);
			memo.finishRange();
			assert.strictEqual(memo.frame(memo.key('frame', 'a', first.txnLogKey, 0)), undefined);
			assert.strictEqual(memo.stats.entries, 0);
		} finally {
			memo.close();
		}
	});

	it('reuses the first observed origin only after the complete key boundary', function () {
		if (lmdb) this.skip();
		const T = newTable();
		const origins = ['z', 'a'].map((name) => getIdOfRemoteNode(`history-first-${sequence}-${name}`, T.auditStore));
		const memo = new HistoryMemo(T.primaryStore, T.tableId, {}, 'a');
		const frame = origins.map((nodeId, n) => {
			const entry = readAuditEntry(
				Buffer.from(
					createAuditEntry({
						type: 'put',
						tableId: T.tableId,
						recordId: 'a',
						nodeId,
						version: 1234,
						encodedRecord: Buffer.from(T.primaryStore.encoder.encode({ id: 'a', n })),
					})
				)
			);
			entry.txnLogKey = 1234;
			entry.endTxn = true;
			return entry;
		});
		const counter = meter(T);
		try {
			memo.beginRange();
			memo.observe(frame[0]);
			assert.strictEqual(memo.frame(memo.key('frame', 'a', 1234, origins[0])), undefined);
			assert.strictEqual(memo.frame(memo.key('frame', 'a', 1234)), undefined);
			memo.observe(frame[1]);
			memo.finishRange();
			for (const committedRef of [false, true]) {
				const selected = readAuditFrame(T.auditStore, T.tableId, 'a', 1234, undefined, committedRef, memo);
				assert.strictEqual(selected[0].nodeId, origins[0]);
				assert.strictEqual(selected[0].getValue(T.primaryStore).n, 0);
			}
			const other = readAuditFrame(T.auditStore, T.tableId, 'a', 1234, origins[1], true, memo);
			assert.strictEqual(other[0].nodeId, origins[1]);
			assert.strictEqual(other[0].getValue(T.primaryStore).n, 1);
			assert.strictEqual(counter.reads, 0);
		} finally {
			counter.close();
			memo.close();
		}
	});

	it('isolates memo origins, ids, visibility modes and calls', async () => {
		const T = newTable();
		await T.put({ id: 'a', n: 0 });
		const [entry] = entries(T);
		const first = new HistoryMemo(T.primaryStore, T.tableId);
		const second = new HistoryMemo(T.primaryStore, T.tableId);
		try {
			const key = first.key('frame', 'a', entry.txnLogKey, 0, true);
			first.rememberFrame(key, [first.snapshot(entry)], true);
			assert.strictEqual(first.frame(first.key('frame', 'a', entry.txnLogKey, 0, false)), undefined);
			assert.strictEqual(first.frame(first.key('frame', 'b', entry.txnLogKey, 0, true)), undefined);
			assert.strictEqual(first.frame(first.key('frame', 'a', entry.txnLogKey, undefined, true)), undefined);
			assert.strictEqual(second.frame(key), undefined);
			assert.strictEqual(first.frame(key)[0].recordId, 'a');
		} finally {
			first.close();
			second.close();
		}
	});

	it('ignores a foreign table context at a shared transaction key', async () => {
		const A = newTable();
		const B = newTable();
		await transaction(async () => {
			await A.put({ id: 'same', n: 1 });
			await B.put({ id: 'same', n: 99 });
		});
		const memo = new HistoryMemo(A.primaryStore, A.tableId);
		try {
			const keyA = entries(A)[0].txnLogKey;
			const keyB = entries(B)[0].txnLogKey;
			assert.strictEqual(getRecordAtTime(undefined, keyA, A.primaryStore, A.tableId, 'same', 0, memo).n, 1);
			assert.strictEqual(getRecordAtTime(undefined, keyB, B.primaryStore, B.tableId, 'same', 0, memo).n, 99);
		} finally {
			memo.close();
		}
	});

	it('drops a carried image after a corrupt patch operation partly applies', async () => {
		const T = newTable();
		await T.put({ id: 'a', n: 0, name: 'unchanged' });
		for (let n = 1; n <= 3; n++) await T.patch('a', { n });
		const patches = entries(T).filter((entry) => entry.type === 'patch');
		const reader = new HistoryReader(T.primaryStore, T.tableId, () => true);
		try {
			const previous = reader.read(patches[0]);
			const original = patches[1];
			const corrupt = readAuditEntry(
				Buffer.from(
					createAuditEntry({
						type: 'patch',
						tableId: T.tableId,
						recordId: 'a',
						nodeId: original.nodeId,
						version: original.version,
						previousVersion: original.previousVersion,
						previousNodeId: original.previousNodeId,
						encodedRecord: Buffer.from(
							T.primaryStore.encoder.encode({ name: 'partial change', n: { __op__: 'unsupported', value: 1 } })
						),
					})
				)
			);
			corrupt.txnLogKey = original.txnLogKey;
			corrupt.previousVersion = original.previousVersion;
			assert.strictEqual(corrupt.getValue(T.primaryStore, false).n.__op__, 'unsupported');
			assert.deepStrictEqual(
				corrupt.getValue(T.primaryStore, true, original.txnLogKey),
				original.getValue(T.primaryStore, true, original.txnLogKey)
			);
			assert.deepStrictEqual(reader.read(corrupt), original.getValue(T.primaryStore, true, original.txnLogKey));
			assert.strictEqual(previous.name, 'unchanged');
			assert.deepStrictEqual(reader.read(patches[2]), patches[2].getValue(T.primaryStore, true, patches[2].txnLogKey));
		} finally {
			reader.memo.close();
		}
	});

	it('rejects corrupt native frames and repeats the plain rebuild', async function () {
		if (lmdb) this.skip();
		const T = newTable();
		await T.put({ id: 'a', n: 0 });
		const root = T.primaryStore.rootStore;
		root.transactionSync((txn) => {
			ENTRY_DATAVIEW.setUint32(0, 0);
			const good = Buffer.from(
				createAuditEntry(
					{ type: 'delete', tableId: T.tableId, recordId: 'a', nodeId: 0, version: txn.getTimestamp() },
					4
				)
			);
			T.auditStore.log.addEntry(good, txn.id);
			T.auditStore.log.addEntry(Buffer.alloc(2), txn.id);
		});
		const all = [...T.auditStore.getRange({ start: 1 })];
		const valid = all.filter((entry) => entry.tableId === T.tableId).at(-1);
		assert(all.some((entry) => entry.txnLogKey === valid.txnLogKey && entry.type === undefined));
		const memo = new HistoryMemo(T.primaryStore, T.tableId);
		try {
			const expected = getRecordAtTime(undefined, valid.txnLogKey, T.primaryStore, T.tableId, 'a', 0);
			for (let i = 0; i < 2; i++)
				assert.deepStrictEqual(
					getRecordAtTime(undefined, valid.txnLogKey, T.primaryStore, T.tableId, 'a', 0, memo),
					expected
				);
			assert.strictEqual(memo.fallbacks, 1);
			assert.strictEqual(memo.stats.entries, 0);
		} finally {
			memo.close();
		}
	});

	it('uses independent contexts after writes between streaming yields', async () => {
		const T = newTable();
		await T.put({ id: 'a', n: 0 });
		await T.patch('a', { n: 1 });
		const iterator = T.getHistory();
		await iterator.next();
		await T.patch('a', { n: 2 });
		await iterator.return();
		assert.deepStrictEqual(values(await T.getHistoryOfRecord('a')), plainHistory(T, 'a'));
	});

	it('abandons copied frames when retention advances during a read', async function () {
		if (!lmdb) this.skip();
		const T = newTable();
		await T.put({ id: 'a', n: 0 });
		await T.patch('a', { n: 1 });
		await T.patch('a', { n: 2 });
		const firstPatch = entries(T).find((entry) => entry.type === 'patch');
		const key = firstPatch.txnLogKey;
		const memo = new HistoryMemo(T.primaryStore, T.tableId);
		const atTime = (context) =>
			getRecordAtTime(T.primaryStore.getEntry('a'), key, T.primaryStore, T.tableId, 'a', 0, context);
		try {
			const before = atTime(memo);
			assert.strictEqual(before.n, 1);
			await removeAuditEntry(T.auditStore, firstPatch);
			raiseAuditFloor(T.auditStore, key + 0.001);
			assert.strictEqual(T.auditStore.get(key), undefined);
			const expected = atTime();
			assert.notDeepStrictEqual(expected, before);
			assert.deepStrictEqual(atTime(memo), expected);
		} finally {
			memo.close();
		}
	});

	it('keeps full replay values and count/filter order', async () => {
		const T = newTable();
		const startTime = Date.now() - 1;
		await T.put({ id: 'a', n: 0 });
		for (let n = 1; n <= 5; n++) await T.patch('a', { n });
		for (const isCollection of [true, false]) {
			const subscription = await T.subscribe({
				id: isCollection ? undefined : 'a',
				isCollection,
				startTime,
				includeSuperseded: true,
			});
			const events = [];
			subscription.on('data', (event) => events.push(event));
			try {
				await waitFor(() => events.length >= 6, { timeout: 5000 });
				assert.deepStrictEqual(
					events.slice(0, 6).map((event) => event.value.n),
					[0, 1, 2, 3, 4, 5]
				);
			} finally {
				subscription.end();
			}
		}
		const filtered = [];
		const events = [];
		const subscription = await T.subscribe({
			id: 'a',
			previousCount: 1,
			includeSuperseded: true,
			eventFilter: (event) => {
				filtered.push(event.value.n);
				return event.value.n % 2 === 0;
			},
			listener: (event) => events.push(event),
		});
		try {
			await waitFor(() => events.length >= 1, { timeout: 5000 });
			assert.deepStrictEqual(filtered, [5, 4]);
			assert.deepStrictEqual(
				events.map((event) => event.value.n),
				[4]
			);
		} finally {
			subscription.end();
		}
	});
});
