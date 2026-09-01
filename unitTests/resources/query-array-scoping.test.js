require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { parseQuery } = require('#src/resources/search');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Contract under test: resources/DESIGN.md → "What do chained conditions mean over array
// values?". Convention: tests titled `pins harper#NNNN` assert today's defective output so
// the suite stays green; each has an it.skip twin asserting the correct behavior to enable
// when the defect is fixed.
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
				{ name: 'skiLengths', elements: { type: 'Int' } },
				{ name: 'skiLengthsIdx', elements: { type: 'Int' }, indexed: true },
				{ name: 'tags', elements: { type: 'String' } },
				{ name: 'tagsIdx', elements: { type: 'String' }, indexed: true },
			],
		});

		const skiers = [
			{ id: 1, name: 'Kris', lengths: [172, 174, 181], tags: ['presale', 'sales'] },
			{ id: 2, name: 'Ann', lengths: [176, 178], tags: ['sale'] },
			{ id: 3, name: 'Bob', lengths: [150], tags: ['new'] },
			{ id: 4, name: 'Cat', lengths: [175], tags: [] },
			{ id: 5, name: 'Dan', lengths: null, tags: null },
			{ id: 6, name: 'Eli', lengths: [180], tags: [] },
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

	// the branch REST takes: RequestTarget parses the query string onto itself and
	// Table.search throws any recorded target.parseError
	function searchRest(queryString) {
		return Skiers.search(new RequestTarget('?' + queryString));
	}

	describe('chained conditions are same-element scoped', () => {
		it('parses a chained condition onto the previous condition', () => {
			const parsed = parseQuery('skiLengths=ge=175&=le=180');
			assert.strictEqual(parsed.conditions.length, 1);
			// untyped FIQL values stay strings at parse time; only the parent condition's
			// value is coerced during query planning (harper#2433)
			assert.deepStrictEqual(parsed.conditions[0], {
				comparator: 'ge',
				attribute: 'skiLengths',
				value: '175',
				operator: 'and',
				chainedConditions: [{ comparator: 'le', attribute: null, value: '180' }],
			});
		});
		it('unindexed array, programmatic: only records with a single element inside the range match', async function () {
			assert.deepStrictEqual(
				await collectIds(
					Skiers.search({
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
				[2, 4, 6]
			);
		});
		it('indexed array, programmatic: same records; pins harper#2434 duplicate for the two-element match', async function () {
			// one result per matching index entry proves the per-element index (not a table
			// scan) served the collapsed range; the duplicated id 2 is harper#2434 — change
			// to [2, 4, 6] when fixed
			assert.deepStrictEqual(
				await collectIds(
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
				[2, 2, 4, 6]
			);
		});
		it('REST route with typed values agrees on both paths', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=ge=number:175&=le=number:180')), [2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=ge=number:175&=le=number:180')), [2, 2, 4, 6]);
		});
		it('exclusive chain (gt/lt) excludes both bounds; inclusive chain (ge/le) includes them', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=gt=number:175&=lt=number:180')), [2]);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=gt=number:175&=lt=number:180')), [2, 2]);
		});
		it('pins harper#2433: untyped REST chain degenerates', async function () {
			// prepareConditions coerces only the parent value, so the collapsed range is
			// [175, '180']; every number sorts below a string, making the string upper bound
			// a no-op (superset) and a string lower bound exclude everything (empty set)
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=ge=175&=le=180')), [1, 2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=le=180&=ge=175')), []);
		});
		it.skip('harper#2433: untyped REST chained range must coerce the chained leg', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=ge=175&=le=180')), [2, 4, 6]);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=le=180&=ge=175')), [2, 4, 6]);
		});
		it.skip('harper#2434: indexed chained range must not duplicate a record with two in-range elements', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=ge=number:175&=le=number:180')), [2, 4, 6]);
		});
	});

	describe('independent repeated conditions are independently existential', () => {
		it('unindexed array: different elements may satisfy different legs', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=ge=175&skiLengths=le=180')), [1, 2, 4, 6]);
		});
		it('indexed array: same matching records as unindexed', async function () {
			// unique ids: which leg leads the scan is estimate-dependent, so the harper#2434
			// duplicate pattern is not stable here
			assert.deepStrictEqual(
				await collectUniqueIds(searchRest('skiLengthsIdx=ge=175&skiLengthsIdx=le=180')),
				[1, 2, 4, 6]
			);
		});
		it.skip('harper#2434: indexed lead condition must not duplicate records into the result', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=ge=175&skiLengthsIdx=le=180')), [1, 2, 4, 6]);
		});
	});

	describe('unsupported chain forms fail loudly (never silently drop a leg)', () => {
		it('or-chained conditions (|=) are rejected', async function () {
			// harper#2435: a plain Error whose message miscounts one chained condition as
			// "multiple"; should be a ClientError naming or-chaining as unsupported
			await assert.rejects(
				(async () => {
					for await (const _ of searchRest('skiLengths=ge=175|=le=180'));
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
					for await (const _ of searchRest('skiLengths=ge=170&=le=180&=ge=171'));
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
		it('string elements, indexed: same records; pins harper#2434 duplicate for the two-element match', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('tagsIdx=ct=sale')), [1, 1, 2]);
		});
		it('numeric elements, unindexed: decimal-string substring of any element matches', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths=ct=17')), [1, 2, 4]);
		});
		it('numeric elements, indexed: same records; pins harper#2434 duplicates', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=ct=17')), [1, 1, 2, 2, 4]);
		});
		it.skip('harper#2434: indexed contains must not duplicate records with several matching elements', async function () {
			assert.deepStrictEqual(await collectIds(searchRest('tagsIdx=ct=sale')), [1, 2]);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengthsIdx=ct=17')), [1, 2, 4]);
		});
		it('programmatic string value against numeric elements: same result', async function () {
			assert.deepStrictEqual(
				await collectIds(
					Skiers.search({ conditions: [{ attribute: 'skiLengths', comparator: 'contains', value: '17' }] })
				),
				[1, 2, 4]
			);
		});
		it('whole-element matching is equality, not contains', async function () {
			assert.deepStrictEqual(
				await collectIds(Skiers.search({ conditions: [{ attribute: 'tags', comparator: 'equals', value: 'sale' }] })),
				[2]
			);
			assert.deepStrictEqual(await collectIds(searchRest('skiLengths==175')), [4]);
		});
	});
});
