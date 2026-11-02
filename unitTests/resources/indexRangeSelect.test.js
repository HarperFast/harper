const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table, closeDatabase, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { addAnalyticsListener, checkAnalyticsEnabled, setAnalyticsEnabled } = require('#src/resources/analytics/write');
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

	describe('covered selects', function () {
		let Covered;

		before(async function () {
			Covered = table({
				table: 'IndexRangeCoveredTest',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'score', indexed: true, type: 'Int' },
					{ name: 'name', indexed: true, type: 'String' },
					{ name: 'label' },
					{ name: 'tags', indexed: true, elements: { type: 'String' } },
					{ name: 'when', indexed: true, type: 'Date' },
					{ name: 'big', indexed: true, type: 'BigInt' },
				],
			});
			const puts = [];
			for (let id = 1; id <= 30; id++) {
				puts.push(
					Covered.put(id, {
						score: id % 10,
						name: `name-${String(id).padStart(2, '0')}${id % 4 ? '' : '-son'}`,
						label: `label-${30 - id}`,
						tags: [`t${id % 3}`, `t${(id % 3) + 1}`],
						when: id % 5 ? new Date(Date.UTC(2026, 0, id)) : null,
						big: BigInt(id) * 1000n,
					})
				);
			}
			await Promise.all(puts);
		});

		after(function () {
			Covered.dropTable();
		});

		async function withReads(Table, callback) {
			const store = Table.primaryStore;
			const getEntry = store.getEntry;
			let reads = 0;
			store.getEntry = function (id, options) {
				reads++;
				return getEntry.call(this, id, options);
			};
			try {
				const result = await callback();
				return { result, reads };
			} finally {
				store.getEntry = getEntry;
			}
		}
		async function rows(Table, query, context) {
			const results = [];
			for await (const row of Table.search(query, context)) results.push(row);
			return results;
		}
		function rowsSync(Table, query) {
			const results = [];
			for (const row of Table.search(query)) results.push(row);
			return results;
		}
		function project(record, select) {
			if (typeof select === 'string') return record[select];
			if (select.asArray) return select.map((name) => record[name]);
			const projected = {};
			for (const name of select)
				projected[name] = record[name] === undefined && select.forceNulls ? null : record[name];
			return projected;
		}
		async function assertCovered(Table, query, expected) {
			const { result, reads } = await withReads(Table, () => rows(Table, query));
			assert.deepStrictEqual(result, expected, `rows for ${JSON.stringify(query.select)}`);
			assert.equal(reads, 0, `primary reads for ${JSON.stringify(query.select)}`);
		}

		it('serves a primary-key or scanned-attribute select from the index, with the rows the record path returns', async function () {
			const asArray = ['id', 'score'];
			asArray.asArray = true;
			const forceNulls = ['id', 'score'];
			forceNulls.forceNulls = true;
			const selects = [
				['id'],
				['id', 'score'],
				['score'],
				['score', 'id', 'score'],
				'id',
				'score',
				asArray,
				forceNulls,
			];
			const queries = [
				{ conditions: [{ attribute: 'score', comparator: 'between', value: [3, 6] }] },
				{ conditions: [{ attribute: 'score', value: 4 }] },
				{
					conditions: [{ attribute: 'score', comparator: 'gt', value: 6 }],
					sort: { attribute: 'score', descending: true },
				},
				{ conditions: [{ attribute: 'score', comparator: 'between', value: [2, 8] }], limit: 3, offset: 2 },
			];
			for (const query of queries) {
				const records = await rows(Covered, query);
				assert.ok(records.length > 0);
				for (const select of selects) {
					const expected = records.map((record) => project(record, select));
					await assertCovered(Covered, { ...query, select }, expected);
					const { result, reads } = await withReads(Covered, () => rowsSync(Covered, { ...query, select }));
					assert.deepStrictEqual(result, expected);
					assert.equal(reads, 0);
				}
			}
		});

		it('covers scans whose condition filter runs on the index key', async function () {
			const queries = [
				{ conditions: [{ attribute: 'name', comparator: 'ends_with', value: '-son' }], select: ['id', 'name'] },
				{ conditions: [{ attribute: 'name', comparator: 'contains', value: '-1' }], select: ['id', 'name'] },
				{ conditions: [{ attribute: 'score', comparator: 'ne', value: 5 }], select: ['id', 'score'] },
				{ conditions: [{ attribute: 'score', comparator: 'in', value: [1, 8] }], select: ['id'] },
				{ sort: { attribute: 'score' }, select: ['id', 'score'] },
			];
			for (const query of queries) {
				const expected = (await rows(Covered, { ...query, select: undefined })).map((record) =>
					project(record, query.select)
				);
				assert.ok(expected.length > 0);
				await assertCovered(Covered, query, expected);
			}
		});

		it('loads records when the index entry cannot answer the query', async function () {
			const range = [{ attribute: 'score', comparator: 'between', value: [3, 6] }];
			const records = await rows(Covered, { conditions: range });
			await assertCovered(
				Covered,
				{ conditions: range, select: ['id', 'score'] },
				records.map(({ id, score }) => ({ id, score }))
			);

			const loads = async (query, expected, context) => {
				const { result, reads } = await withReads(Covered, () => rows(Covered, query, context));
				assert.deepStrictEqual(result, expected, JSON.stringify(query));
				assert.ok(reads >= expected.length && reads > 0, `expected record reads for ${JSON.stringify(query)}`);
			};
			// another index's attribute is not in the scanned entry
			await loads(
				{ conditions: range, select: ['id', 'name'] },
				records.map(({ id, name }) => ({ id, name }))
			);
			const byLabel = [...records].sort((a, b) => (a.label < b.label ? -1 : 1));
			await loads(
				{ conditions: range, sort: { attribute: 'label' }, select: ['id', 'score'] },
				byLabel.map(({ id, score }) => ({ id, score }))
			);
			const chained = [...records].sort((a, b) => a.score - b.score || (a.label < b.label ? -1 : 1));
			await loads(
				{ conditions: range, sort: { attribute: 'score', next: { attribute: 'label' } }, select: ['id', 'score'] },
				chained.map(({ id, score }) => ({ id, score }))
			);
			const visible = records.filter(({ label }) => label !== 'label-26');
			await loads(
				{ conditions: range, rowFilter: (record) => record.label !== 'label-26', select: ['id', 'score'] },
				visible.map(({ id, score }) => ({ id, score }))
			);
			await loads(
				{ conditions: range, vectorFilter: (record) => record.label !== 'label-26', select: ['id', 'score'] },
				visible.map(({ id, score }) => ({ id, score }))
			);
			const named = records.filter(({ name }) => name.endsWith('-son'));
			await loads(
				{
					conditions: [...range, { attribute: 'name', comparator: 'ends_with', value: '-son' }],
					select: ['id', 'score'],
				},
				named.map(({ id, score }) => ({ id, score }))
			);
			const either = await rows(Covered, {
				operator: 'or',
				conditions: [
					{ attribute: 'score', value: 3 },
					{ attribute: 'score', value: 4 },
				],
			});
			await loads(
				{
					operator: 'or',
					conditions: [
						{ attribute: 'score', value: 3 },
						{ attribute: 'score', value: 4 },
					],
					select: ['id'],
				},
				either.map(({ id }) => ({ id }))
			);
			const { result: resolved, reads } = await withReads(Covered, () =>
				rows(Covered, { conditions: range, select: ['id', '$updatedtime'] })
			);
			assert.equal(resolved.length, records.length);
			assert.ok(reads > 0);
			// local-only reads skip invalidated rows, which the index entry does not mark
			await loads(
				{ conditions: range, select: ['id', 'score'] },
				records.map(({ id, score }) => ({ id, score })),
				{ replicateFrom: false }
			);
		});

		it('returns an expired row until eviction removes it', async function () {
			const Expiring = table({
				table: 'IndexRangeCoveredExpiryTest',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'score', indexed: true }, { name: 'label' }],
			});
			try {
				await Expiring.put({ id: 1, score: 5, label: 'kept' });
				await Expiring.put({ id: 2, score: 5, label: 'expired' }, { expiresAt: Date.now() - 1000 });
				const condition = [{ attribute: 'score', value: 5 }];
				await assertCovered(Expiring, { conditions: condition, select: ['id', 'score'] }, [
					{ id: 1, score: 5 },
					{ id: 2, score: 5 },
				]);
				// the RocksDB record-loading path keeps hiding it (LMDB's does not reliably)
				if (!isLMDB)
					assert.deepStrictEqual(
						(await rows(Expiring, { conditions: condition })).map(({ id, label }) => ({ id, label })),
						[{ id: 1, label: 'kept' }]
					);
			} finally {
				Expiring.dropTable();
			}
		});

		it('decodes index values by the declared type and returns what the index holds otherwise', async function () {
			const nonNull = [{ attribute: 'when', comparator: 'gt', value: new Date(Date.UTC(2026, 0, 1)) }];
			const expectedWhen = (await rows(Covered, { conditions: nonNull })).map(({ id, when }) => ({ id, when }));
			await assertCovered(Covered, { conditions: nonNull, select: ['id', 'when'] }, expectedWhen);
			assert.ok(expectedWhen[0].when instanceof Date);
			const nullWhen = [{ attribute: 'when', value: null }];
			await assertCovered(
				Covered,
				{ conditions: nullWhen, select: ['id', 'when'] },
				[5, 10, 15, 20, 25, 30].map((id) => ({ id, when: null }))
			);
			const bigRange = [{ attribute: 'big', comparator: 'between', value: [3000n, 5000n] }];
			await assertCovered(Covered, { conditions: bigRange, select: ['id', 'big'] }, [
				{ id: 3, big: 3000n },
				{ id: 4, big: 4000n },
				{ id: 5, big: 5000n },
			]);
			// a declared multi-valued attribute yields the matching element, one row per record
			const tagged = [{ attribute: 'tags', comparator: 'between', value: ['t1', 't2'] }];
			const taggedIds = (await rows(Covered, { conditions: tagged, select: ['id', 'label'] })).map(({ id }) => id);
			const { result: tagRows, reads } = await withReads(Covered, () =>
				rows(Covered, { conditions: tagged, select: ['id', 'tags'] })
			);
			assert.equal(reads, 0);
			assert.deepStrictEqual(
				tagRows.map(({ id }) => id),
				taggedIds
			);
			for (const { id, tags } of tagRows) {
				assert.ok(tags === 't1' || tags === 't2');
				assert.ok([`t${id % 3}`, `t${(id % 3) + 1}`].includes(tags));
			}

			const Loose = table({
				table: 'IndexRangeCoveredLooseTest',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value', indexed: true }, { name: 'label' }],
			});
			try {
				const text256 = 'a'.repeat(256);
				const text257 = 'a'.repeat(257);
				await Loose.put(10n, { value: 1, label: 'bigint id' });
				await Loose.put(2, { value: new Date(Date.UTC(2026, 0, 2)), label: 'date' });
				await Loose.put(3, { value: ['p', 'q'], label: 'array' });
				await Loose.put(4, { value: 99n, label: 'bigint value' });
				await Loose.put(5, { value: text256, label: '256' });
				await Loose.put(6, { value: text257, label: '257' });
				const value = (condition) => [{ attribute: 'value', ...condition }];
				// an undeclared bigint id decodes as a number; the record keeps the bigint
				assert.deepStrictEqual(await rows(Loose, { conditions: value({ value: 1 }), select: ['id', 'label'] }), [
					{ id: 10n, label: 'bigint id' },
				]);
				await assertCovered(Loose, { conditions: value({ value: 1 }), select: ['id', 'value'] }, [
					{ id: 10, value: 1 },
				]);
				await assertCovered(Loose, { conditions: value({ value: Date.UTC(2026, 0, 2) }), select: ['id', 'value'] }, [
					{ id: 2, value: Date.UTC(2026, 0, 2) },
				]);
				await assertCovered(
					Loose,
					{ conditions: value({ comparator: 'between', value: ['p', 'q'] }), select: ['id', 'value'] },
					[
						{ id: 3, value: 'p' },
						{ id: 3, value: 'q' },
					]
				);
				await assertCovered(Loose, { conditions: value({ value: 99 }), select: ['id', 'value'] }, [
					{ id: 4, value: 99 },
				]);
				await assertCovered(Loose, { conditions: value({ value: text256 }), select: ['id', 'value'] }, [
					{ id: 5, value: text256 },
				]);
				// a truncated overflow key cannot supply the value, but still supplies the id
				const prefixed = value({ comparator: 'starts_with', value: 'aaa' });
				const { result, reads } = await withReads(Loose, () =>
					rows(Loose, { conditions: prefixed, select: ['id', 'value'] })
				);
				assert.deepStrictEqual(result, [
					{ id: 5, value: text256 },
					{ id: 6, value: text257 },
				]);
				assert.equal(reads, 1);
				await assertCovered(Loose, { conditions: prefixed, select: ['id'] }, [{ id: 5 }, { id: 6 }]);
				// a row whose key overflowed takes the same shape as the rows around it
				const long = 'b'.repeat(300);
				await Loose.put(7, { value: ['bb', long], label: 'mixed array' });
				await Loose.put(11n, { value: 'b'.repeat(299), label: 'bigint id, long value' });
				const mixed = await withReads(Loose, () =>
					rows(Loose, { conditions: value({ comparator: 'starts_with', value: 'bb' }), select: ['id', 'value'] })
				);
				assert.deepStrictEqual(mixed.result, [
					{ id: 7, value: 'bb' },
					{ id: 7, value: long },
					{ id: 11, value: 'b'.repeat(299) },
				]);
				assert.equal(mixed.reads, 2);
				// an overflow entry stands for the element it indexes, and only when that element matches
				const prefix = 'd'.repeat(256);
				await Loose.put(8, { value: ['c'.repeat(260), 'match-me-c'], label: 'one long element' });
				await Loose.put(9, { value: [prefix + '1', prefix + '2'], label: 'shared prefix' });
				const endsWith = await withReads(Loose, () =>
					rows(Loose, { conditions: value({ comparator: 'ends_with', value: 'me-c' }), select: ['id', 'value'] })
				);
				assert.deepStrictEqual(endsWith.result, [{ id: 8, value: 'match-me-c' }]);
				const shared = await withReads(Loose, () =>
					rows(Loose, { conditions: value({ value: prefix + '2' }), select: ['id', 'value'] })
				);
				assert.deepStrictEqual(shared.result, [{ id: 9, value: prefix + '2' }]);
				assert.equal(shared.reads, 1);
				const sorted = (await rows(Loose, { sort: { attribute: 'value' } })).map(({ id }) => ({ id: Number(id) }));
				await assertCovered(Loose, { sort: { attribute: 'value' }, select: ['id'] }, sorted);
			} finally {
				Loose.dropTable();
			}
		});

		it('yields between overflow entries a covered scan rejects', async function () {
			let scanning = true;
			const Long = table({
				table: 'IndexRangeCoveredYieldTest',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'value', indexed: true },
				],
			});
			try {
				for (let id = 1; id <= 20; id++) await Long.put(id, { value: ['e'.repeat(300) + id] });
				let turns = 0;
				const tick = () => {
					turns++;
					if (scanning) setImmediate(tick);
				};
				setImmediate(tick);
				for (const select of [['id', 'value'], ['id']]) {
					const before = turns;
					const result = await rows(Long, {
						conditions: [{ attribute: 'value', comparator: 'ends_with', value: 'none' }],
						select,
					});
					assert.deepStrictEqual(result, []);
					assert.ok(turns - before >= 10, `the scan yielded ${turns - before} times across 20 rejected entries`);
				}
			} finally {
				scanning = false;
				Long.dropTable();
			}
		});

		it('keeps a value the declared type cannot reconstruct as the index holds it', async function () {
			const attributes = (amount, when) => [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'amount', indexed: true, type: amount },
				{ name: 'when', indexed: true, type: when },
			];
			let Amounts = table({
				table: 'IndexRangeCoveredRedeclareTest',
				database: 'test',
				attributes: attributes(undefined, undefined),
			});
			try {
				await Amounts.put(1, { amount: 1.5, when: 1.5 });
				await Amounts.put(2, { amount: 7, when: 9e15 });
				Amounts = table({
					table: 'IndexRangeCoveredRedeclareTest',
					database: 'test',
					attributes: attributes('BigInt', 'Date'),
				});
				await Amounts.indexingOperation;
				await assertCovered(
					Amounts,
					{ conditions: [{ attribute: 'amount', comparator: 'between', value: [1n, 2n] }], select: ['id', 'amount'] },
					[{ id: 1, amount: 1.5 }]
				);
				await assertCovered(
					Amounts,
					{ conditions: [{ attribute: 'when', comparator: 'gt', value: new Date(1) }], select: ['id', 'when'] },
					[
						{ id: 1, when: 1.5 },
						{ id: 2, when: 9e15 },
					]
				);
			} finally {
				Amounts.dropTable();
			}
		});

		it('serves a reopened table holding non-scalar and -0 values under an untyped index', async function () {
			const databaseName = 'covered_reopen';
			const declare = () =>
				table({
					table: 'Reopened',
					database: databaseName,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value', indexed: true }, { name: 'label' }],
				});
			let Reopened = declare();
			try {
				await Reopened.put(1, { value: 5, label: 'number' });
				await Reopened.put(2, { value: 7n, label: 'bigint' });
				await Reopened.put(3, { value: [6, 8], label: 'array' });
				await Reopened.put(4, { value: { nested: 6 }, label: 'object' });
				await Reopened.put(5, { value: -0, label: 'negative zero' });
				await Reopened.put({ id: [null, 7], value: '\x18', label: 'control character' });
				// the id RocksDB decodes from record 5's -0 entry
				await Reopened.put({ id: [null, null, null, 5], value: 'x', label: 'decoded twin' });
				await closeDatabase(databaseName);
				resetDatabases();
				Reopened = declare();
				const open = [{ attribute: 'value', comparator: 'gt', value: 4 }];
				const loaded = await rows(Reopened, { conditions: open, select: ['id', 'label'] });
				const { result, reads } = await withReads(Reopened, () =>
					rows(Reopened, { conditions: open, select: ['id', 'value'] })
				);
				// in index order: the array row once per matching element, the object row not at all (it is not
				// indexed), the -0 row as LMDB's record path reads it, and on RocksDB, where record 5's -0 entry
				// decodes to the twin's id, no row for that entry (the record path serves the twin there)
				assert.deepStrictEqual(result, [
					{ id: 1, value: 5 },
					{ id: 3, value: 6 },
					{ id: 2, value: 7 },
					{ id: 3, value: 8 },
					...(isLMDB ? [{ id: 5, value: 0 }] : []),
					{ id: [null, 7], value: '\x18' },
					// ids come back as the index decodes them: RocksDB's composite key drops one leading null here
					{ id: isLMDB ? [null, null, null, 5] : [null, null, 5], value: 'x' },
				]);
				assert.deepStrictEqual(
					loaded.filter(({ id }) => id !== 5 && !Array.isArray(id)).map(({ id }) => id),
					[1, 3, 2, 3]
				);
				// a null-led id under a '\x18' key is checked against its record, since -0 decodes that way on RocksDB
				assert.equal(reads, isLMDB ? 1 : 2);
			} finally {
				Reopened.dropTable();
			}
		});

		it('serves an invalidated row from its indexed projection, and skips it for local-only reads', async function () {
			const Stubs = table({
				table: 'IndexRangeCoveredStubTest',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'score', indexed: true }, { name: 'label' }],
			});
			try {
				await Stubs.put(1, { score: 5, label: 'one' });
				await Stubs.put(2, { score: 5, label: 'two' });
				await Stubs.invalidate(2);
				const condition = [{ attribute: 'score', value: 5 }];
				const expected = [
					{ id: 1, score: 5 },
					{ id: 2, score: 5 },
				];
				assert.deepStrictEqual(await rows(Stubs, { conditions: condition, select: ['id', 'score', 'label'] }), [
					{ id: 1, score: 5, label: 'one' },
					{ id: 2, score: 5, label: undefined },
				]);
				await assertCovered(Stubs, { conditions: condition, select: ['id', 'score'] }, expected);
				assert.deepStrictEqual(
					await rows(Stubs, { conditions: condition, select: ['id', 'score'] }, { replicateFrom: false }),
					[{ id: 1, score: 5 }]
				);
			} finally {
				Stubs.dropTable();
			}
		});

		it('records one db-read per covered row', async function () {
			const wasEnabled = checkAnalyticsEnabled();
			setAnalyticsEnabled(true);
			try {
				const reads = [];
				addAnalyticsListener((metrics) => {
					for (const metric of metrics)
						if (metric.metric === 'db-read' && metric.path === 'IndexRangeCoveredTest') reads.push(metric);
				});
				const tagged = [{ attribute: 'tags', comparator: 'between', value: ['t1', 't2'] }];
				const { result, reads: primaryReads } = await withReads(Covered, () =>
					rows(Covered, { conditions: tagged, select: ['id', 'tags'] })
				);
				assert.equal(primaryReads, 0);
				await waitFor(() => reads.length > 0, { timeout: 10_000, message: 'no analytics report was flushed' });
				assert.equal(reads[0].count, result.length);
				assert.equal(reads[0].mean, 1);
			} finally {
				setAnalyticsEnabled(wasEnabled);
			}
		});

		it('leaves the index readable after an early return, and scans its read snapshot on RocksDB', async function () {
			const Snapshot = table({
				table: 'IndexRangeCoveredSnapshotTest',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'score', indexed: true },
				],
			});
			try {
				for (let id = 1; id <= 5; id++) await Snapshot.put(id, { score: id * 10 });
				const query = {
					conditions: [{ attribute: 'score', comparator: 'between', value: [10, 100] }],
					select: ['id', 'score'],
				};
				const { result } = await withReads(Snapshot, async () => {
					for await (const row of Snapshot.search(query)) return row;
				});
				assert.deepStrictEqual(result, { id: 1, score: 10 });
				const before = [1, 2, 3, 4, 5].map((id) => ({ id, score: id * 10 }));
				if (!isLMDB) {
					const iterator = Snapshot.search(query)[Symbol.asyncIterator]();
					const scanned = [(await iterator.next()).value];
					await Snapshot.put(3, { score: 999 });
					await Snapshot.put(6, { score: 25 });
					await Snapshot.delete(4);
					for (let step = await iterator.next(); !step.done; step = await iterator.next()) scanned.push(step.value);
					assert.deepStrictEqual(scanned, before);
					// an overflow row's value is read in the same snapshot as its index entry
					const long = (suffix) => 'f'.repeat(300) + suffix;
					await Snapshot.put(7, { score: long('a') });
					await Snapshot.put(8, { score: long('b') });
					const overflowQuery = {
						conditions: [{ attribute: 'score', comparator: 'starts_with', value: 'fff' }],
						select: ['id', 'score'],
					};
					const overflow = Snapshot.search(overflowQuery)[Symbol.asyncIterator]();
					const overflowRows = [(await overflow.next()).value];
					await Snapshot.put(8, { score: long('changed') });
					for (let step = await overflow.next(); !step.done; step = await overflow.next())
						overflowRows.push(step.value);
					assert.deepStrictEqual(overflowRows, [
						{ id: 7, score: long('a') },
						{ id: 8, score: long('b') },
					]);
					await Snapshot.delete(7);
					await Snapshot.delete(8);
				} else {
					await Snapshot.put(3, { score: 999 });
					await Snapshot.put(6, { score: 25 });
					await Snapshot.delete(4);
				}
				await assertCovered(Snapshot, query, [
					{ id: 1, score: 10 },
					{ id: 2, score: 20 },
					{ id: 6, score: 25 },
					{ id: 5, score: 50 },
				]);
			} finally {
				Snapshot.dropTable();
			}
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
