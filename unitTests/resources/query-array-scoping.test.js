require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { parseQuery } = require('#src/resources/search');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { table } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { writeKey } = require('ordered-binary');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Contract under test: resources/DESIGN.md → "What do chained conditions mean over array
// values?". Convention: tests titled `pins harper#NNNN` assert today's defective output so
// the suite stays green; each has an it.skip twin asserting the correct behavior to enable
// when the defect is fixed. The harper#2434 twins are live — indexed elements-array scans no
// longer emit one result per matching index entry.
describe('Array-valued property scoping', () => {
	let Widgets;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		Widgets = table({
			table: 'ArrayScopeWidgets',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', type: 'String' },
				{ name: 'sizes', elements: { type: 'Int' } },
				{ name: 'sizesIdx', elements: { type: 'Int' }, indexed: true },
				{ name: 'tags', elements: { type: 'String' } },
				{ name: 'tagsIdx', elements: { type: 'String' }, indexed: true },
			],
		});

		const widgets = [
			{ id: 1, name: 'alpha', lengths: [172, 174, 181], tags: ['presale', 'sales'] },
			{ id: 2, name: 'bravo', lengths: [176, 178], tags: ['sale'] },
			{ id: 3, name: 'charlie', lengths: [150], tags: ['new'] },
			{ id: 4, name: 'delta', lengths: [175], tags: [] },
			{ id: 5, name: 'echo', lengths: null, tags: null },
			{ id: 6, name: 'foxtrot', lengths: [180], tags: [] },
		];
		for (const { id, name, lengths, tags } of widgets) {
			await Widgets.put({ id, name, sizes: lengths, sizesIdx: lengths, tags, tagsIdx: tags });
		}
	});

	async function collectIds(iter) {
		const ids = [];
		for await (const record of iter) ids.push(record.id);
		return ids.sort((a, b) => a - b);
	}
	async function collectUniqueIds(iter) {
		return [...new Set(await collectIds(iter))];
	}
	async function collectIdsInOrder(iter) {
		const ids = [];
		for await (const record of iter) ids.push(record.id);
		return ids;
	}

	// the branch REST takes: RequestTarget parses the query string onto itself and
	// Table.search throws any recorded target.parseError
	function searchRest(queryString) {
		return Widgets.search(new RequestTarget('?' + queryString));
	}

	describe('chained conditions are same-element scoped', () => {
		it('parses a chained condition onto the previous condition', () => {
			const parsed = parseQuery('sizes=ge=175&=le=180');
			assert.strictEqual(parsed.conditions.length, 1);
			// untyped FIQL values stay strings at parse time; only the parent condition's
			// value is coerced during query planning (harper#2433)
			assert.deepStrictEqual(parsed.conditions[0], {
				comparator: 'ge',
				attribute: 'sizes',
				value: '175',
				operator: 'and',
				chainedConditions: [{ comparator: 'le', attribute: null, value: '180' }],
			});
		});
		it('unindexed array, programmatic: only records with a single element inside the range match', async function () {
			assert.deepStrictEqual(
				await collectIds(
					Widgets.search({
						conditions: [
							{
								attribute: 'sizes',
								comparator: 'ge',
								value: 175,
								chainedConditions: [{ comparator: 'le', value: 180 }],
							},
						],
					})
				),
				[2, 4, 6]
			);
		});
		it('indexed array, programmatic: same records as unindexed, each returned once', async function () {
			assert.deepStrictEqual(
				await collectIds(
					Widgets.search({
						conditions: [
							{
								attribute: 'sizesIdx',
								comparator: 'ge',
								value: 175,
								chainedConditions: [{ comparator: 'le', value: 180 }],
							},
						],
					})
				),
				[2, 4, 6]
			);
		});
		it('REST route with typed values agrees on both paths', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizes=ge=number:175&=le=number:180')), [2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=ge=number:175&=le=number:180')), [2, 4, 6]);
		});
		it('exclusive chain (gt/lt) excludes both bounds; inclusive chain (ge/le) includes them', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizes=gt=number:175&=lt=number:180')), [2]);
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=gt=number:175&=lt=number:180')), [2]);
		});
		it('pins harper#2433: untyped REST chain degenerates', async function () {
			// prepareConditions coerces only the parent value, so the collapsed range is
			// [175, '180']; every number sorts below a string, making the string upper bound
			// a no-op (superset) and a string lower bound exclude everything (empty set)
			assert.deepStrictEqual(await collectIds(searchRest('sizes=ge=175&=le=180')), [1, 2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('sizes=le=180&=ge=175')), []);
		});
		it.skip('harper#2433: untyped REST chained range must coerce the chained leg', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizes=ge=175&=le=180')), [2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('sizes=le=180&=ge=175')), [2, 4, 6]);
		});
		it('harper#2434: indexed chained range must not duplicate a record with two in-range elements', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=ge=number:175&=le=number:180')), [2, 4, 6]);
		});
	});

	describe('independent repeated conditions are independently existential', () => {
		it('unindexed array: different elements may satisfy different legs', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizes=ge=175&sizes=le=180')), [1, 2, 4, 6]);
		});
		it('indexed array: same matching records as unindexed', async function () {
			assert.deepStrictEqual(await collectUniqueIds(searchRest('sizesIdx=ge=175&sizesIdx=le=180')), [1, 2, 4, 6]);
		});
		it('harper#2434: indexed lead condition must not duplicate records into the result', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=ge=175&sizesIdx=le=180')), [1, 2, 4, 6]);
		});
	});

	describe('unsupported chain forms fail loudly (never silently drop a leg)', () => {
		it('or-chained conditions (|=) are rejected', async function () {
			// harper#2435: a plain Error whose message miscounts one chained condition as
			// "multiple"; should be a ClientError naming or-chaining as unsupported
			await assert.rejects(
				(async () => {
					for await (const _ of searchRest('sizes=ge=175|=le=180'));
				})(),
				/chained conditions/i
			);
		});
		it('non-range chained comparators are rejected', async function () {
			await assert.rejects(
				(async () => {
					for await (const _ of searchRest('tags=sw=pre&=ew=ale'));
				})(),
				/chained/i
			);
		});
		it('a second chained leg is rejected at parse time', async function () {
			// harper#2435: after a chained leg the parser state falls back to the tokenizer
			// that splits `&=`, so REST clients get this misleading SyntaxViolation and the
			// planner's multiple-chained-conditions error is unreachable
			await assert.rejects(
				(async () => {
					for await (const _ of searchRest('sizes=ge=170&=le=180&=ge=171'));
				})(),
				/attribute must be specified before equality comparator/
			);
		});
	});

	describe('contains over array values: per-element toString substring', () => {
		it('string elements, unindexed: substring of any element matches', async function () {
			// 'presale' and 'sales' match as substrings without equaling 'sale'
			assert.deepStrictEqual(await collectIds(searchRest('tags=ct=sale')), [1, 2]);
		});
		it('string elements, indexed: same records as unindexed, each returned once', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('tagsIdx=ct=sale')), [1, 2]);
		});
		it('numeric elements, unindexed: decimal-string substring of any element matches', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizes=ct=17')), [1, 2, 4]);
		});
		it('numeric elements, indexed: same records as unindexed, each returned once', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=ct=17')), [1, 2, 4]);
		});
		it('harper#2434: indexed contains must not duplicate records with several matching elements', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('tagsIdx=ct=sale')), [1, 2]);
			assert.deepStrictEqual(await collectIds(searchRest('sizesIdx=ct=17')), [1, 2, 4]);
		});
		it('programmatic string value against numeric elements: same result', async function () {
			assert.deepStrictEqual(
				await collectIds(Widgets.search({ conditions: [{ attribute: 'sizes', comparator: 'contains', value: '17' }] })),
				[1, 2, 4]
			);
		});
		it('whole-element matching is equality, not contains', async function () {
			assert.deepStrictEqual(
				await collectIds(Widgets.search({ conditions: [{ attribute: 'tags', comparator: 'equals', value: 'sale' }] })),
				[2]
			);
			assert.deepStrictEqual(await collectIds(searchRest('sizes==175')), [4]);
		});
	});

	describe('limit/offset pages count records, not index entries', () => {
		// sizesIdx entries in index order: 150→3, 172→1, 174→1, 175→4, 176→2, 178→2, 180→6,
		// 181→1. Record 1 owns three of them, and they are NOT contiguous — 175/176/178/180
		// belong to other records — so the page window has to be applied to a stream that has
		// already collapsed record 1 to its first matching entry.
		// a fresh condition object per call: the planner mutates conditions in place (coercion,
		// comparator normalization, cached estimates)
		const geAll = (page) => ({ conditions: [{ attribute: 'sizesIdx', comparator: 'ge', value: 150 }], ...page });

		it('an unpaged scan returns each record once, at its first matching element', async function () {
			assert.deepStrictEqual(await collectIdsInOrder(Widgets.search(geAll())), [3, 1, 4, 2, 6]);
		});

		it('every distinct record appears exactly once across a full page sweep', async function () {
			const limit = 2;
			const pages = [];
			for (let offset = 0; offset < 20; offset += limit) {
				const page = await collectIdsInOrder(Widgets.search(geAll({ offset, limit })));
				if (page.length === 0) break;
				pages.push(page);
			}
			assert.deepStrictEqual(pages, [[3, 1], [4, 2], [6]]);
			const swept = pages.flat();
			assert.deepStrictEqual(
				[...swept].sort((a, b) => a - b),
				[1, 2, 3, 4, 6],
				'the sweep must cover every qualifying record'
			);
			assert.strictEqual(swept.length, new Set(swept).size, 'no record may appear on more than one page');
		});

		it('a full page is a full page of distinct records', async function () {
			assert.deepStrictEqual(await collectIdsInOrder(Widgets.search(geAll({ limit: 4 }))), [3, 1, 4, 2]);
		});
	});

	// The programmatic `elements`-only declaration leaves `attribute.type` undefined, which sends
	// condition values through coerceType's autoCast branch. A GraphQL `[Int]` declares
	// `type: 'array'` with the element type nested underneath and takes the uncoerced default
	// branch, so it is a separate route to the same index scan and is asserted on its own.
	describe('GraphQL-declared elements attribute', () => {
		let GqlWidgets;

		before(async function () {
			await loadGQLSchema(`
				type ArrayScopeGqlWidget @table {
					id: Int! @primaryKey
					sizes: [Int] @indexed
					tags: [String] @indexed
					weight: Int @indexed
				}
			`);
			GqlWidgets = tables.ArrayScopeGqlWidget;
			const widgets = [
				{ id: 1, sizes: [172, 174, 181], tags: ['presale', 'sales'], weight: 10 },
				{ id: 2, sizes: [176, 178], tags: ['sale'], weight: 20 },
				{ id: 3, sizes: [150], tags: ['new'], weight: 30 },
				{ id: 4, sizes: [175], tags: [], weight: 40 },
				{ id: 6, sizes: [180], tags: [], weight: 50 },
				{ id: 7, sizes: [190, 190], tags: ['dup', 'dup'], weight: 60 },
			];
			for (const widget of widgets) await GqlWidgets.put(widget);
		});

		function gqlSearch(target) {
			return GqlWidgets.search(target);
		}

		it('declares the array shape GraphQL produces', function () {
			const sizes = GqlWidgets.attributes.find((attribute) => attribute.name === 'sizes');
			assert.strictEqual(sizes.type, 'array');
			assert.strictEqual(sizes.elements.type, 'Int');
		});

		it('chained range returns each record once', async function () {
			assert.deepStrictEqual(
				await collectIds(
					gqlSearch({
						conditions: [
							{
								attribute: 'sizes',
								comparator: 'ge',
								value: 175,
								chainedConditions: [{ comparator: 'le', value: 180 }],
							},
						],
					})
				),
				[2, 4, 6]
			);
		});

		it('contains returns each record once even when its entries are not adjacent', async function () {
			// 'presale' and 'sales' both belong to record 1 and sort either side of record 2's
			// 'sale', so the duplicate this drops is two positions away from its original.
			assert.deepStrictEqual(
				await collectIdsInOrder(
					gqlSearch({ conditions: [{ attribute: 'tags', comparator: 'contains', value: 'sale' }] })
				),
				[1, 2]
			);
		});

		it('equality on an array element is unchanged, including repeated identical elements', async function () {
			assert.deepStrictEqual(
				await collectIds(gqlSearch({ conditions: [{ attribute: 'tags', comparator: 'equals', value: 'dup' }] })),
				[7]
			);
			assert.deepStrictEqual(
				await collectIds(gqlSearch({ conditions: [{ attribute: 'sizes', comparator: 'equals', value: 190 }] })),
				[7]
			);
		});

		it('a scalar indexed attribute is unchanged', async function () {
			assert.deepStrictEqual(
				await collectIdsInOrder(gqlSearch({ conditions: [{ attribute: 'weight', comparator: 'ge', value: 20 }] })),
				[2, 3, 4, 6, 7]
			);
			assert.deepStrictEqual(
				await collectIdsInOrder(
					gqlSearch({ conditions: [{ attribute: 'weight', comparator: 'ge', value: 20 }], offset: 2, limit: 2 })
				),
				[4, 6]
			);
		});

		it('every distinct record appears exactly once across a full page sweep', async function () {
			const limit = 2;
			const swept = [];
			for (let offset = 0; offset < 20; offset += limit) {
				const page = await collectIdsInOrder(
					gqlSearch({ conditions: [{ attribute: 'sizes', comparator: 'ge', value: 150 }], offset, limit })
				);
				if (page.length === 0) break;
				assert.ok(page.length <= limit, 'a page may not exceed its limit');
				swept.push(...page);
			}
			assert.deepStrictEqual(swept, [3, 1, 4, 2, 6, 7]);
			assert.strictEqual(swept.length, new Set(swept).size, 'no record may appear on more than one page');
		});
	});

	describe('record identity across repeated index entries', () => {
		let KeyedWidgets;
		// a scalar string id holding exactly the bytes the dedup encodes ['t', 9] into: tracking
		// encoded and scalar keys in one set would fold the two records together
		const encodedKeyBuffer = Buffer.allocUnsafe(64);
		const collidingId = encodedKeyBuffer.toString('latin1', 0, writeKey(['t', 9], encodedKeyBuffer, 0));

		before(async function () {
			KeyedWidgets = table({
				table: 'ArrayScopeKeyedWidgets',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'tagsIdx', elements: { type: 'String' }, indexed: true },
				],
			});
			// 't\u00007' is what ['t', 7] collapses to under flattenKey (`key.join('\u0000')`), so
			// those two records are one key to that helper and two keys to the store.
			await KeyedWidgets.put({ id: ['t', 7], tagsIdx: ['a', 'z'] });
			await KeyedWidgets.put({ id: 't\u00007', tagsIdx: ['b'] });
			await KeyedWidgets.put({ id: ['t', 9], tagsIdx: ['c', 'y'] });
			await KeyedWidgets.put({ id: collidingId, tagsIdx: ['d'] });
			await KeyedWidgets.put({ id: ['t', 8], tagsIdx: ['m'] });
		});

		// index entries: a→['t',7], b→'t\u00007', c→['t',9], d→collidingId, m→['t',8],
		// y→['t',9], z→['t',7]. Two records own two entries each, and neither pair is adjacent.
		function scanFromA() {
			return KeyedWidgets.search({ conditions: [{ attribute: 'tagsIdx', comparator: 'ge', value: 'a' }] });
		}
		async function collectKeys(iter) {
			const keys = [];
			for await (const record of iter) keys.push(record.id);
			return keys;
		}

		it('an array primary key is one record, not one per decoded array instance', async function () {
			// the repeated entries for ['t', 7] and ['t', 9] decode to equal but distinct array
			// objects, so object identity cannot tell them apart, and flattenKey would fold
			// ['t', 7] into the record keyed 't\u00007'
			assert.deepStrictEqual(await collectKeys(scanFromA()), [['t', 7], 't\u00007', ['t', 9], collidingId, ['t', 8]]);
		});

		it('an encoded array key does not collide with a scalar id carrying the same bytes', async function () {
			const ids = await collectKeys(scanFromA());
			assert.ok(
				ids.some((id) => Array.isArray(id) && id[0] === 't' && id[1] === 9),
				`the array key is missing from ${JSON.stringify(ids)}`
			);
			assert.ok(ids.includes(collidingId), `the scalar key is missing from ${JSON.stringify(ids)}`);
		});
	});

	describe('order, counting, and comparator aliases', () => {
		it('a descending scan keeps each record at its first entry in scan order', async function () {
			assert.deepStrictEqual(
				await collectIdsInOrder(
					Widgets.search({ conditions: [{ attribute: 'sizesIdx', comparator: 'ge', value: 150, descending: true }] })
				),
				[1, 6, 2, 4, 3]
			);
		});

		it("count: 'exact' totals records, not index entries", async function () {
			const page = await Widgets.search({
				conditions: [{ attribute: 'sizesIdx', comparator: 'ge', value: 150 }],
				offset: 0,
				limit: 2,
				count: 'exact',
			});
			assert.deepStrictEqual(
				page.map((record) => record.id),
				[3, 1]
			);
			assert.strictEqual(page.recordCount, 5);
			assert.strictEqual(page.recordCountExact, true);
		});

		it('equality aliases resolve to the same single-value scan', async function () {
			for (const comparator of ['equals', 'eq', undefined]) {
				assert.deepStrictEqual(
					await collectIds(Widgets.search({ conditions: [{ attribute: 'tagsIdx', comparator, value: 'sale' }] })),
					[2],
					`comparator ${comparator}`
				);
			}
		});
	});

	describe('scope boundary: an attribute not declared as an array', () => {
		let LooseWidgets;

		before(async function () {
			LooseWidgets = table({
				table: 'ArrayScopeLooseWidgets',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true, type: 'Int' },
					{ name: 'values', indexed: true },
				],
			});
			await LooseWidgets.put({ id: 1, values: [10, 20] });
			await LooseWidgets.put({ id: 2, values: [30] });
		});

		it('pins: an undeclared indexed attribute holding arrays still repeats per entry', async function () {
			// `values` has neither a type nor `elements`, so the schema does not say it is
			// multi-valued; a record that happens to store an array there still gets one index
			// entry per element. Deduping it is deliberately outside this change's boundary.
			assert.deepStrictEqual(
				await collectIdsInOrder(
					LooseWidgets.search({ conditions: [{ attribute: 'values', comparator: 'ge', value: 10 }] })
				),
				[1, 1, 2]
			);
		});
	});
});
