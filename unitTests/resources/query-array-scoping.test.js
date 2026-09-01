require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { parseQuery } = require('#src/resources/search');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Pins the element-scoping semantics of queries over array-valued (elements) properties.
//
// Verified semantics (correct, guarded by the green tests):
//  - A chained condition (`a=ge=X&=le=Y`, condition.chainedConditions) is SAME-ELEMENT
//    scoped: one element must satisfy every leg. The planner collapses the chain into a
//    single range comparator (Table.ts prepareConditions), so the indexed path (per-element
//    index entries scanned with one range) and the unindexed path (per-element `some` over
//    one range predicate, search.ts attributeComparator) agree.
//  - Repeating the attribute as independent conditions (`a=ge=X&a=le=Y`) is independently
//    existential: different elements may satisfy different legs.
//  - `contains` on an array value is a per-element substring test over
//    `element.toString()`, for string and numeric elements alike, and never scans by a
//    range (full-scan filter), so indexed and unindexed attributes agree on membership.
//
// Known defects documented here (green tests pin today's behavior and should be flipped
// when the defect is fixed; the it.skip twins assert the correct behavior):
//  - harper#2433 — REST chained-leg values are never type-coerced, so an untyped chained
//    range on a numeric attribute silently degenerates (superset or empty set).
//  - harper#2434 — index-driven scans over elements attributes yield one result per
//    matching index entry, duplicating records with several in-range elements.
//  - harper#2435 — chained-condition error paths (second `&=` leg unparseable, `|=`
//    rejected with a wrong message/plain Error).
describe('Array-valued property scoping', () => {
	let Skiers;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		Skiers = table({
			table: 'ArrayScopeSkiers',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', type: 'String' },
				{ name: 'skiLengths', elements: { type: 'Int' } }, // unindexed numeric array
				{ name: 'skiLengthsIdx', elements: { type: 'Int' }, indexed: true }, // indexed numeric array
				{ name: 'tags', elements: { type: 'String' } }, // unindexed string array
				{ name: 'tagsIdx', elements: { type: 'String' }, indexed: true }, // indexed string array
			],
		});

		// The same array values are stored under both the unindexed and indexed attribute,
		// so identical queries against either column must return the same ids if the two
		// paths agree.
		const skiers = [
			// straddles [175,180]: elements on both sides, none inside
			{ id: 1, name: 'Kris', lengths: [172, 174, 181], tags: ['presale', 'fresh'] },
			// two elements inside [175,180] (duplicate-id probe for the index scan)
			{ id: 2, name: 'Ann', lengths: [176, 178], tags: ['sale'] },
			{ id: 3, name: 'Bob', lengths: [150], tags: ['new'] },
			// exactly on the inclusive lower bound
			{ id: 4, name: 'Cat', lengths: [175], tags: [] },
			{ id: 5, name: 'Dan', lengths: null, tags: null },
		];
		for (const { id, name, lengths, tags } of skiers) {
			await Skiers.put({ id, name, skiLengths: lengths, skiLengthsIdx: lengths, tags, tagsIdx: tags });
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

	function searchParsed(queryString) {
		const parsed = parseQuery(queryString);
		if (parsed.parseError) throw parsed.parseError;
		return Skiers.search({ allowFullScan: true, conditions: parsed.conditions });
	}

	describe('chained conditions are same-element scoped', () => {
		it('parses a chained condition onto the previous condition (values stay strings)', () => {
			const parsed = parseQuery('skiLengths=ge=175&=le=180');
			assert.equal(parsed.conditions.length, 1);
			const [condition] = parsed.conditions;
			// typedDecoding leaves untyped FIQL values as strings; prepareConditions later
			// coerces only the parent value, never the chained leg's (harper#2433)
			assert.deepStrictEqual(condition, {
				comparator: 'ge',
				attribute: 'skiLengths',
				value: '175',
				operator: 'and',
				chainedConditions: [{ comparator: 'le', attribute: null, value: '180' }],
			});
		});
		it('unindexed array, programmatic: no single element in [175,180] must NOT match', async function () {
			// Kris [172,174,181] straddles the range but no element is inside it
			assert.deepEqual(
				await collectIds(
					Skiers.search({
						allowFullScan: true,
						conditions: [
							{
								attribute: 'skiLengths',
								comparator: 'ge',
								value: 175,
								chainedConditions: [{ comparator: 'le', value: 180 }],
							},
						],
					})
				),
				[2, 4]
			);
		});
		it('indexed array, programmatic: same matching records as unindexed', async function () {
			assert.deepEqual(
				await collectUniqueIds(
					Skiers.search({
						conditions: [
							{
								attribute: 'skiLengthsIdx',
								comparator: 'ge',
								value: 175,
								chainedConditions: [{ comparator: 'le', value: 180 }],
							},
						],
					})
				),
				[2, 4]
			);
		});
		it('REST route with typed values agrees on both paths', async function () {
			assert.deepEqual(await collectIds(searchParsed('skiLengths=ge=number:175&=le=number:180')), [2, 4]);
			assert.deepEqual(await collectUniqueIds(searchParsed('skiLengthsIdx=ge=number:175&=le=number:180')), [2, 4]);
		});
		it('exclusive chain (gt/lt) keeps the collapsed bounds exclusive', async function () {
			// Cat [175] sits on the bound: in for ge/le, out for gt/lt
			assert.deepEqual(await collectIds(searchParsed('skiLengths=gt=number:175&=lt=number:180')), [2]);
			assert.deepEqual(await collectUniqueIds(searchParsed('skiLengthsIdx=gt=number:175&=lt=number:180')), [2]);
		});
		it('pins harper#2433: untyped REST chain degenerates (string upper bound is a no-op)', async function () {
			// [175, '180'] — every number sorts below the string bound, so `le` excludes
			// nothing and Kris (181) wrongly matches. Flip to [2, 4] when #2433 is fixed.
			assert.deepEqual(await collectIds(searchParsed('skiLengths=ge=175&=le=180')), [1, 2, 4]);
			// swapped legs put the string on the lower bound, which excludes every number
			assert.deepEqual(await collectIds(searchParsed('skiLengths=le=180&=ge=175')), []);
		});
		it.skip('harper#2433: untyped REST chained range must coerce the chained leg', async function () {
			assert.deepEqual(await collectIds(searchParsed('skiLengths=ge=175&=le=180')), [2, 4]);
			assert.deepEqual(await collectIds(searchParsed('skiLengths=le=180&=ge=175')), [2, 4]);
		});
		it.skip('harper#2434: indexed chained range must not duplicate a record with two in-range elements', async function () {
			const ids = [];
			for await (const record of searchParsed('skiLengthsIdx=ge=number:175&=le=number:180')) ids.push(record.id);
			assert.deepEqual(
				ids.sort((a, b) => a - b),
				[2, 4]
			);
		});
	});

	describe('independent repeated conditions are independently existential', () => {
		it('unindexed array: different elements may satisfy different legs', async function () {
			// Kris matches: 181 satisfies ge=175, 172 satisfies le=180
			assert.deepEqual(await collectIds(searchParsed('skiLengths=ge=175&skiLengths=le=180')), [1, 2, 4]);
		});
		it('indexed array: same matching records as unindexed', async function () {
			assert.deepEqual(await collectUniqueIds(searchParsed('skiLengthsIdx=ge=175&skiLengthsIdx=le=180')), [1, 2, 4]);
		});
		it.skip('harper#2434: indexed lead condition must not duplicate records into the result', async function () {
			assert.deepEqual(await collectIds(searchParsed('skiLengthsIdx=ge=175&skiLengthsIdx=le=180')), [1, 2, 4]);
		});
	});

	describe('unsupported chain forms fail loudly (never silently drop a leg)', () => {
		it('or-chained conditions (|=) are rejected', async function () {
			// harper#2435: today a plain Error with a message about "multiple" chained
			// conditions; should become a ClientError naming or-chaining as unsupported
			await assert.rejects(
				(async () => {
					for await (const _ of searchParsed('skiLengths=ge=175|=le=180'));
				})(),
				/chained conditions/i
			);
		});
		it('non-range chained comparators are rejected', async function () {
			await assert.rejects(
				(async () => {
					for await (const _ of searchParsed('tags=sw=pre&=ew=ale'));
				})(),
				/chained/i
			);
		});
		it('a second chained leg is rejected at parse time', async function () {
			// harper#2435: after a chained leg the parser falls back to the tokenizer that
			// splits `&=`, so this dies with a misleading parse error (and a TypeError when
			// parseQuery is called without a query object) instead of the planner's
			// "Multiple chained conditions are not currently supported"
			await assert.rejects(
				(async () => {
					for await (const _ of searchParsed('skiLengths=ge=170&=le=180&=ge=171'));
				})(),
				/Unable to parse query/
			);
		});
	});

	describe('contains over array values: per-element toString substring', () => {
		it('string elements, unindexed: substring of any element matches', async function () {
			// 'presale' (Kris) proves substring semantics, not whole-element equality
			assert.deepEqual(await collectIds(searchParsed('tags=ct=sale')), [1, 2]);
		});
		it('string elements, indexed: same result as unindexed', async function () {
			assert.deepEqual(await collectIds(searchParsed('tagsIdx=ct=sale')), [1, 2]);
		});
		it('numeric elements, unindexed: decimal-string substring of any element matches', async function () {
			// "172".includes("17") → Kris; "176" → Ann; "175" → Cat; Bob "150" and Dan null do not
			assert.deepEqual(await collectIds(searchParsed('skiLengths=ct=17')), [1, 2, 4]);
		});
		it('numeric elements, indexed: same matching records as unindexed', async function () {
			assert.deepEqual(await collectUniqueIds(searchParsed('skiLengthsIdx=ct=17')), [1, 2, 4]);
		});
		it.skip('harper#2434: indexed contains must not duplicate records with several matching elements', async function () {
			assert.deepEqual(await collectIds(searchParsed('skiLengthsIdx=ct=17')), [1, 2, 4]);
		});
		it('programmatic string value against numeric elements: same result', async function () {
			assert.deepEqual(
				await collectIds(
					Skiers.search({
						allowFullScan: true,
						conditions: [{ attribute: 'skiLengths', comparator: 'contains', value: '17' }],
					})
				),
				[1, 2, 4]
			);
		});
		it('whole-element matching is equality, not contains', async function () {
			// equality on an array attribute is per-element too: any element === value
			assert.deepEqual(
				await collectIds(
					Skiers.search({
						allowFullScan: true,
						conditions: [{ attribute: 'tags', comparator: 'equals', value: 'sale' }],
					})
				),
				[2]
			);
			// coercing REST equality (`==`) auto-casts the value, unlike contains
			assert.deepEqual(await collectIds(searchParsed('skiLengths==175')), [4]);
		});
	});
});
