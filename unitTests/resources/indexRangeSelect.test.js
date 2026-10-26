const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Secondary-index range select', function () {
	let Records;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'IndexRangeSelectTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'score', indexed: true },
				{ name: 'name' },
				{ name: 'category' },
				{ name: 'nested' },
			],
		});
		const puts = [];
		for (let id = 1; id <= 30; id++) {
			const record = { score: id % 10, name: `name-${id}`, nested: { label: `label-${id}`, other: id } };
			if (id % 3) record.category = `cat-${id % 3}`;
			puts.push(Records.put(id, record));
		}
		await Promise.all(puts);
	});

	after(function () {
		Records.dropTable();
	});

	const range = [{ attribute: 'score', comparator: 'between', value: [3, 6] }];

	async function collect(query) {
		const results = [];
		for await (const record of Records.search(query)) results.push(record);
		return results;
	}

	function collectSync(query) {
		const results = [];
		for (const record of Records.search(query)) results.push(record);
		return results;
	}

	describe('RocksIndexStore.getRange', function () {
		let index;
		let decoder;
		let decode;
		let decodes;

		before(function () {
			if (isLMDB) return this.skip();
			index = Records.indices.score;
			decoder = index.store.decoder;
			decode = decoder.decode;
			decoder.decode = function (...args) {
				decodes++;
				return decode.apply(this, args);
			};
		});
		beforeEach(function () {
			decodes = 0;
		});
		after(function () {
			if (decoder) decoder.decode = decode;
		});

		function expectedEntries(low, high) {
			const entries = [];
			for (let score = low; score <= high; score++) {
				for (let id = 1; id <= 30; id++) if (id % 10 === score) entries.push({ key: score, value: id });
			}
			return entries;
		}

		it('decodes no stored index value, even when the caller asks for values', function () {
			// control: the base iterator asked for values decodes every stored (null) value, so the
			// spy does observe this store's decodes
			const raw = [...RocksDatabase.prototype.getRange.call(index, { start: 3, end: 5, values: true })];
			assert.ok(raw.length > 0);
			assert.equal(decodes, raw.length);

			decodes = 0;
			const entries = [...index.getRange({ start: 3, end: 6, inclusiveEnd: true, values: true })];
			assert.equal(decodes, 0, 'an index range scan must not decode the stored values');
			assert.deepStrictEqual(entries, expectedEntries(3, 6));
		});

		it('yields a distinct entry per index row, in reverse and with exclusive bounds', function () {
			const reversed = [...index.getRange({ start: 6, end: 3, reverse: true, values: true })];
			assert.equal(decodes, 0);
			assert.deepStrictEqual(reversed, expectedEntries(4, 6).reverse());
			assert.equal(new Set(reversed).size, reversed.length, 'each row is its own entry object');

			const exclusive = [...index.getRange({ start: 3, end: 6, exclusiveStart: true, values: true })];
			assert.deepStrictEqual(exclusive, expectedEntries(4, 5));
		});

		it('splits a composite primary key off the indexed value', async function () {
			const Composite = table({
				table: 'IndexRangeSelectCompositeTest',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'score', indexed: true },
				],
			});
			try {
				await Composite.put(['a', 2], { score: 7 });
				await Composite.put(['b', 1], { score: 7 });
				const entries = [...Composite.indices.score.getRange({ start: 7, end: 7, inclusiveEnd: true })];
				assert.deepStrictEqual(entries, [
					{ key: 7, value: ['a', 2] },
					{ key: 7, value: ['b', 1] },
				]);
			} finally {
				Composite.dropTable();
			}
		});

		it('an abandoned scan leaves the index readable', function () {
			for (const entry of index.getRange({ start: 0, end: 9, inclusiveEnd: true })) {
				assert.equal(entry.key, 0);
				break;
			}
			assert.deepStrictEqual([...index.getRange({ start: 9, end: 9, inclusiveEnd: true })], expectedEntries(9, 9));
		});
	});

	describe('select over an index range', function () {
		let fullRecords;

		before(async function () {
			fullRecords = await collect({ conditions: range });
			assert.equal(fullRecords.length, 12);
		});

		const project = (record, names) => {
			const projected = {};
			for (const name of names) projected[name] = record[name];
			return projected;
		};

		it('plain columns match a projection of the full records, async and sync', async function () {
			const select = ['id', 'score', 'name', 'category', 'missing'];
			const expected = fullRecords.map((record) => project(record, select));
			assert.deepStrictEqual(await collect({ conditions: range, select }), expected);
			assert.deepStrictEqual(collectSync({ conditions: range, select }), expected);
		});

		it('forceNulls maps missing columns to null', async function () {
			const select = ['id', 'category', 'missing'];
			select.forceNulls = true;
			const expected = fullRecords.map((record) => ({
				id: record.id,
				category: record.category ?? null,
				missing: null,
			}));
			assert.deepStrictEqual(await collect({ conditions: range, select }), expected);
		});

		it('mixes plain columns with a resolver, a wildcard and duplicates', async function () {
			const mixed = await collect({ conditions: range, select: ['id', '$updatedtime', 'name', 'name'] });
			assert.deepStrictEqual(
				mixed.map(({ id, name }) => ({ id, name })),
				fullRecords.map(({ id, name }) => ({ id, name }))
			);
			assert.deepStrictEqual(Object.keys(mixed[0]), ['id', '$updatedtime', 'name']);
			for (const record of mixed) assert.equal(typeof record.$updatedtime, 'number');

			const wildcard = await collect({ conditions: range, select: ['*', 'name'] });
			assert.deepStrictEqual(
				wildcard,
				fullRecords.map((record) => ({ ...record }))
			);
		});

		it('asArray and nested selects keep their shape', async function () {
			const asArray = ['id', 'name'];
			asArray.asArray = true;
			assert.deepStrictEqual(
				await collect({ conditions: range, select: asArray }),
				fullRecords.map(({ id, name }) => [id, name])
			);
			assert.deepStrictEqual(
				await collect({ conditions: range, select: ['id', { name: 'nested', select: ['label'] }] }),
				fullRecords.map(({ id, nested }) => ({ id, nested: { label: nested.label } }))
			);
		});
	});

	describe('transformEntryForSelect', function () {
		it('reads each selected column once, with a plain column before a nested select', function () {
			let reads = 0;
			const record = {
				id: 1,
				get count() {
					return ++reads;
				},
				nested: { label: 'x', other: 2 },
			};
			const transform = Records.transformEntryForSelect(
				['count', { name: 'nested', select: ['label'] }],
				{},
				undefined,
				null
			);
			assert.deepStrictEqual(transform({ key: 1, value: record }), { count: 1, nested: { label: 'x' } });
			assert.equal(reads, 1);
		});

		it('projects a plain column exactly as the general path projects it', function () {
			function method() {}
			const record = {
				id: 1,
				text: 'x',
				count: 0,
				flag: false,
				empty: null,
				when: new Date(0),
				list: [1, 'two'],
				method,
			};
			const names = ['text', 'count', 'flag', 'empty', 'when', 'list', 'method', 'missing'];
			for (const forceNulls of [false, true]) {
				const plain = names.slice();
				const general = names.map((name) => ({ name }));
				plain.forceNulls = general.forceNulls = forceNulls;
				const fromPlain = Records.transformEntryForSelect(plain, {}, undefined, null)({ key: 1, value: record });
				const fromGeneral = Records.transformEntryForSelect(general, {}, undefined, null)({ key: 1, value: record });
				assert.deepStrictEqual(fromPlain, fromGeneral);
			}
		});

		it('decides per column when the row is projected, not when the transform is built', function () {
			const select = ['id', 'nested'];
			const transform = Records.transformEntryForSelect(select, {}, undefined, null);
			const record = { id: 1, nested: { label: 'x', other: 2 } };
			assert.deepStrictEqual(transform({ key: 1, value: record }), { id: 1, nested: { label: 'x', other: 2 } });
			// transformToOrderedSelect rewrites select columns this way after the transform exists
			select[1] = { name: 'nested', select: ['label'] };
			assert.deepStrictEqual(transform({ key: 1, value: record }), { id: 1, nested: { label: 'x' } });
		});

		it('keeps sync and async loads on separate options, in either order', async function () {
			const store = Records.primaryStore;
			const getEntry = store.getEntry;
			const asyncFlags = [];
			store.getEntry = function (id, options) {
				asyncFlags.push(Boolean(options?.async));
				return getEntry.call(this, id, options);
			};
			try {
				const transform = Records.transformEntryForSelect(['id', 'name'], {}, undefined, null);
				assert.deepStrictEqual(await transform.call({ isSync: false }, 4), { id: 4, name: 'name-4' });
				const synced = transform.call({ isSync: true }, 5);
				assert.equal(typeof synced?.then, 'undefined', 'a sync load must not return a promise');
				assert.deepStrictEqual(synced, { id: 5, name: 'name-5' });
				assert.deepStrictEqual(await transform.call({ isSync: false }, 6), { id: 6, name: 'name-6' });
			} finally {
				store.getEntry = getEntry;
			}
			assert.deepStrictEqual(asyncFlags, [true, false, true]);
		});
	});
});
