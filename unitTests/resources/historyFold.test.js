const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { isNonHistoryType } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

// History listings fold patches forward (createHistoryFold, resources/crdt.ts) instead of rebuilding
// each entry from the live record. The reference here is that per-entry rebuild, read straight from the
// audit log: every listing must return exactly what it returns, at a cost linear in the entries.
const DATABASE = 'historyfold';
const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const add = (value) => ({ __op__: 'add', value });

describe('History listings fold patches forward', () => {
	let sequence = 0;
	const subscriptions = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	afterEach(() => {
		for (const subscription of subscriptions.splice(0)) subscription.end();
	});

	function makeTable(extra = {}) {
		return table({
			database: DATABASE,
			table: `HistoryFold${++sequence}`,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
			...extra,
		});
	}

	// Today's per-entry rebuild: each entry's own image as of its own log position.
	function rebuiltHistory(T, id, startTime = 1) {
		const entries = [];
		for (const auditRecord of T.auditStore.getRange({ start: startTime })) {
			if (auditRecord.tableId !== T.tableId || isNonHistoryType(auditRecord.type)) continue;
			if (auditRecord.recordId !== id) continue;
			entries.push({
				type: auditRecord.type,
				txnLogKey: auditRecord.txnLogKey,
				version: auditRecord.version,
				value: auditRecord.getValue(T.primaryStore, true, auditRecord.txnLogKey),
			});
		}
		return entries;
	}

	// Replays from `startTime` (exclusive) until the event for the log key `through` arrives.
	async function replayed(T, options, through) {
		const events = [];
		const subscription = await T.subscribe({
			startTime: 1,
			includeSuperseded: true,
			...options,
			listener: (event) => events.push(event),
		});
		subscriptions.push(subscription);
		await waitFor(() => events.some((event) => event.localTime >= through), 10_000, 1);
		return events;
	}

	// Compares each listing with the per-entry rebuild of the same log positions. getHistory and the table
	// replay scan the log, so they list exactly the rebuild's entries; getHistoryOfRecord and the
	// per-record replay follow the record's links, which can list fewer once origins interleave.
	async function assertListingsMatchRebuild(T, id, startTime = 1) {
		const expected = rebuiltHistory(T, id, startTime);
		// history entries report the log key on RocksDB and the version on LMDB
		const position = (entry) => (isRocksDB ? entry.txnLogKey : entry.version);
		if (startTime === 1) {
			const ofRecord = await T.getHistoryOfRecord(id);
			assert.ok(ofRecord.length > 0);
			for (const entry of ofRecord) {
				const rebuilt = expected.find(
					(candidate) => position(candidate) === entry.localTime && candidate.type === entry.type
				);
				assert.ok(rebuilt, `getHistoryOfRecord lists a ${entry.type} at ${entry.localTime} the log does not`);
				assert.deepStrictEqual(entry.value, rebuilt.value, `getHistoryOfRecord ${entry.type} at ${entry.localTime}`);
			}
		}
		const scanned = [];
		for await (const entry of T.getHistory(startTime))
			if (entry.id === id) scanned.push([entry.localTime, entry.value]);
		assert.deepStrictEqual(
			scanned,
			expected.map((entry) => [position(entry), entry.value]),
			'getHistory'
		);
		const versions = expected.filter((entry) => entry.type === 'put' || entry.type === 'patch');
		// the table replay sends every entry, newest key last; a per-record replay sends its versions in one batch
		const newest = Math.max(...expected.map((entry) => entry.txnLogKey));
		for (const scope of [{ id }, { isCollection: true }]) {
			const events = await replayed(T, { ...scope, startTime }, scope.isCollection ? newest : -Infinity);
			const puts = events.filter((event) => event.id === id && event.type === 'put');
			if (scope.isCollection) assert.strictEqual(puts.length, versions.length, 'table superseded replay');
			for (const event of puts) {
				const rebuilt = versions.find((candidate) => candidate.txnLogKey === event.localTime);
				assert.ok(
					rebuilt,
					`superseded replay ${JSON.stringify(scope)} sent a version at ${event.localTime} the log does not`
				);
				assert.deepStrictEqual(
					event.value,
					rebuilt.value,
					`superseded replay ${JSON.stringify(scope)} at ${event.localTime}`
				);
			}
		}
	}

	// Applies `update` as a write replicated from the origin `nodeId` at `version`.
	function applyFromOrigin(T, id, update, version, nodeId) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			await resource._writeUpdate(id, update, false, { isNotification: true, nodeId, version });
		});
	}

	// Counts this table's audit reads during `read`, by the reads' own table id.
	async function auditReadsDuring(T, read) {
		const { auditStore } = T;
		const originalGet = auditStore.get;
		const originalGetSync = auditStore.getSync;
		let reads = 0;
		auditStore.get = function (key, tableId, ...rest) {
			if (tableId === T.tableId) reads++;
			return originalGet.call(this, key, tableId, ...rest);
		};
		auditStore.getSync = function (key, tableId, ...rest) {
			if (tableId === T.tableId) reads++;
			return originalGetSync.call(this, key, tableId, ...rest);
		};
		try {
			await read();
		} finally {
			auditStore.get = originalGet;
			auditStore.getSync = originalGetSync;
		}
		return reads;
	}

	it('reads each listing in audit reads linear in the patches', async () => {
		const T = makeTable();
		const patches = 300;
		await T.put({ id: 'counter', tag: 'a', count: 0 });
		for (let i = 0; i < patches; i++) await T.patch('counter', { count: add(1), last: i });
		// the per-entry rebuild walks back from the live record for every patch: about patches² / 2 reads
		const bound = 10 * patches;
		const lastKey = rebuiltHistory(T, 'counter').at(-1).txnLogKey;
		const listings = {
			'getHistoryOfRecord': () => T.getHistoryOfRecord('counter'),
			'getHistory': async () => {
				for await (const entry of T.getHistory()) void entry;
			},
			'per-record superseded replay': () => replayed(T, { id: 'counter' }, lastKey),
			'table superseded replay': () => replayed(T, { isCollection: true }, lastKey),
		};
		for (const [name, read] of Object.entries(listings)) {
			const reads = await auditReadsDuring(T, read);
			assert.ok(reads < bound, `${name} took ${reads} audit reads for ${patches} patches`);
		}
		const history = await T.getHistoryOfRecord('counter');
		assert.deepStrictEqual(history.at(-1).value, { id: 'counter', tag: 'a', count: patches, last: patches - 1 });
	});

	it('returns what the per-entry rebuild returns for random write sequences', async () => {
		for (let seed = 1; seed <= 12; seed++) {
			const T = makeTable();
			let state = seed;
			const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
			const pick = (list) => list[Math.floor(random() * list.length)];
			const ids = ['a', 'b', 'c'];
			for (let step = 0; step < 80; step++) {
				const id = pick(ids);
				const roll = random();
				const field = pick(['x', 'y', 'tag', 'n']);
				if (roll < 0.1) await T.put({ id, x: step, tag: 't' + (step % 3) });
				else if (roll < 0.14) await T.delete(id);
				else if (roll < 0.17) await T.invalidate(id);
				else if (roll < 0.2) await T.publish(id, { message: step });
				else if (roll < 0.45) await T.patch(id, { n: add(Math.floor(random() * 5) - 2) });
				else if (roll < 0.5) await T.patch(id, { [field]: null });
				else if (roll < 0.55) await T.patch(id, { [field]: { nested: step } });
				else await T.patch(id, { [field]: step, ['z' + (step % 4)]: step });
			}
			for (const id of ids) await assertListingsMatchRebuild(T, id);
		}
	});

	it('returns what the per-entry rebuild returns when replicated patches arrive out of order', async () => {
		const T = makeTable();
		const early = getIdOfRemoteNode('history-fold-early-origin', T.auditStore);
		const late = getIdOfRemoteNode('history-fold-late-origin', T.auditStore);
		// future clocks: RocksDB stamps an audit floor at open, and a write below it skips the resequencing walk
		const base = Date.now() + 86_400_000;
		await T.put('merged', { tag: 'a', x: 0, count: 0 }, { timestamp: base });
		for (let i = 1; i <= 6; i++) await applyFromOrigin(T, 'merged', { x: i, count: add(1) }, base + i * 1000, late);
		// older than the head: merged into it, on a branch the head lists rather than on the linear chain
		for (let i = 1; i <= 4; i++)
			await applyFromOrigin(T, 'merged', { ['y' + i]: i, count: add(10) }, base + i * 1000 - 500, early);
		for (let i = 7; i <= 9; i++) await T.patch('merged', { x: i, count: add(1) }, { timestamp: base + i * 1000 });
		const current = T.primaryStore.getEntry('merged').value;
		assert.strictEqual(current.count, 49);
		await assertListingsMatchRebuild(T, 'merged');
	});

	describe('an out-of-order replicated write merged into a local chain', () => {
		// Local writes take the natural clock; a merged write's version falls between two local versions.
		// `at` places it between the two versions, so two merges into one gap get distinct versions
		async function mergeBetween(T, id, older, newer, update, origin, at = 0.5) {
			const [olderVersion, newerVersion] = [older, newer].map((index) => rebuiltHistory(T, id)[index].version);
			await applyFromOrigin(T, id, update, olderVersion + (newerVersion - olderVersion) * at, origin);
		}
		for (const [name, update, after] of [
			['adds a field the head lacks', { y: 'o', count: add(10) }, []],
			['sets a field a newer patch overwrote', { x: 'o', y: 'o', count: add(10) }, []],
			['is followed by an in-order patch', { y: 'o', count: add(10) }, [{ x: 3, count: add(1) }]],
		]) {
			it(name, async () => {
				const T = makeTable();
				const origin = getIdOfRemoteNode(`history-fold-merge-${sequence}`, T.auditStore);
				await T.put({ id: 'r', tag: 'a', x: 0, count: 0 });
				await T.patch('r', { x: 1, count: add(1) });
				await T.patch('r', { x: 2, count: add(1) });
				await mergeBetween(T, 'r', 0, 1, update, origin);
				for (const patch of after) await T.patch('r', patch);
				await assertListingsMatchRebuild(T, 'r');
			});
		}
		it('returns what the per-entry rebuild returns for random merges', async () => {
			for (let seed = 1; seed <= 8; seed++) {
				const T = makeTable();
				const origin = getIdOfRemoteNode(`history-fold-merge-${sequence}`, T.auditStore);
				let state = seed;
				const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
				const pick = (list) => list[Math.floor(random() * list.length)];
				await T.put({ id: 'r', tag: 'a', x: 0, y: 0, count: 0 });
				for (let step = 0; step < 30; step++) {
					const update = { [pick(['x', 'y'])]: step, count: add(1) };
					const length = rebuiltHistory(T, 'r').length;
					if (random() < 0.7 || length < 2) await T.patch('r', update);
					else {
						const older = Math.floor(random() * (length - 1));
						await mergeBetween(T, 'r', older, older + 1, update, origin, 0.1 + 0.8 * random());
					}
				}
				await assertListingsMatchRebuild(T, 'r');
			}
		});
	});

	it('filters a per-record superseded replay newest first and sends the events the per-entry rebuild sends', async () => {
		const folded = makeTable();
		const rebuilt = makeTable({ schemaDefined: false });
		const replay = async (T) => {
			await T.put({ id: 'f', tag: 'a', n: 0 });
			for (let n = 1; n <= 3; n++) await T.patch('f', { n });
			const filtered = [];
			const events = [];
			const subscription = await T.subscribe({
				id: 'f',
				startTime: 1,
				includeSuperseded: true,
				eventFilter: (event) => filtered.push(event.value?.n) > 0,
				listener: (event) => events.push(event),
			});
			subscriptions.push(subscription);
			await waitFor(() => events.length >= 4, 10_000, 1);
			return {
				filtered,
				keys: events.map((event) => Object.keys(event).sort()),
				values: events.map((event) => event.value),
			};
		};
		assert.deepStrictEqual(await replay(folded), await replay(rebuilt));
	});

	it('does not carry an image past an invalidate, including from a range that starts after one', async () => {
		const T = makeTable();
		await T.put({ id: 'stub', tag: 'kept', a: 1, b: 1 });
		await T.patch('stub', { a: 2 });
		await T.invalidate('stub');
		// a patch onto a stub stores only indexed fields
		await T.patch('stub', { b: 3 });
		await T.patch('stub', { a: 4 });
		assert.deepStrictEqual({ ...T.primaryStore.getEntry('stub').value }, { id: 'stub', tag: 'kept' });
		await assertListingsMatchRebuild(T, 'stub');
		// a start between the invalidate and the patch after it: the first entry in range is that patch
		const [invalidated, patched] = rebuiltHistory(T, 'stub').slice(2, 4);
		assert.deepStrictEqual([invalidated.type, patched.type], ['invalidate', 'patch']);
		await assertListingsMatchRebuild(T, 'stub', (invalidated.txnLogKey + patched.txnLogKey) / 2);
	});

	it('stops carrying an image when an invalidate lands during a scan', async function () {
		// an LMDB scan reads a snapshot, so it never sees a write made after it started
		if (!isRocksDB) this.skip();
		const T = makeTable();
		await T.put({ id: 'late', tag: 'kept', a: 1, b: 1 });
		await T.patch('late', { a: 2 });
		const scan = T.getHistory(1);
		const scanned = [(await scan.next()).value];
		// the record was a full row when the scan first saw it
		await T.invalidate('late');
		await T.patch('late', { b: 3 });
		await T.patch('late', { a: 4 });
		for await (const entry of scan) if (entry.id === 'late') scanned.push(entry);
		const expected = rebuiltHistory(T, 'late');
		assert.deepStrictEqual(
			scanned.map((entry) => entry.type),
			expected.map((entry) => entry.type)
		);
		assert.deepStrictEqual(
			scanned.map((entry) => entry.value),
			expected.map((entry) => entry.value)
		);
	});

	it('rebuilds each entry of a schemaless table, whose rows drop_attribute strips without an audit entry', async () => {
		const T = makeTable({ schemaDefined: false });
		await T.put({ id: 'row', tag: 'a', dropped: 'value', n: 1 });
		await T.patch('row', { n: 2 });
		await T.stripAttributeValues(['dropped']);
		await T.patch('row', { n: 3 });
		await T.patch('row', { n: 4 });
		assert.strictEqual(Object.hasOwn(T.primaryStore.getEntry('row').value, 'dropped'), false);
		await assertListingsMatchRebuild(T, 'row');
	});
});
