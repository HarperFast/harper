/**
 * Regression guard for the period during which `runIndexing` is in flight on a
 * populated table after an attribute is freshly marked @indexed. While
 * `dbi.isIndexing === true`, search_by_value on that attribute throws "is not
 * indexed yet" (resources/search.ts). A caller that wraps the search in a
 * catch-all and treats every error as a business-level skip will silently drop
 * its entire workload for the length of the rebuild window.
 *
 * The test exercises the canonical "lookup-then-write" loop against an
 * indexed attribute whose index is mid-rebuild and asserts that the lookup
 * is observably failing for the calling code so consumers can distinguish
 * an infra-level transient from a hit/miss outcome.
 */

const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const assert = require('node:assert/strict');

describe('search_by_value on an attribute whose index is mid-rebuild', function () {
	this.timeout(120000);

	before(async function () {
		setupTestDBPath();
		await loadGQLSchema(`
			type Rule @table {
				id: ID! @primaryKey
				path: String
				target: String
			}
		`);
	});

	it('throws "not indexed yet" for searches issued while runIndexing is in flight', async function () {
		const Rule = tables.Rule;
		const N = 60000;

		for (let chunkStart = 0; chunkStart < N; chunkStart += 1000) {
			await transaction((ctx) => {
				const promises = [];
				for (let i = chunkStart; i < Math.min(chunkStart + 1000, N); i++) {
					promises.push(Rule.put({ id: `seed-${i}`, path: `/p/${i}`, target: `/t/${i}` }, ctx));
				}
				return Promise.all(promises);
			});
		}

		// Before any index exists the search refuses with the plain "not indexed"
		// message; this is the no-index baseline.
		let preErr;
		try {
			Rule.search({ allowFullScan: false, conditions: [{ attribute: 'path', value: '/p/0' }] });
		} catch (e) {
			preErr = e;
		}
		assert.ok(
			preErr?.message.includes('not indexed') && !/not indexed yet/.test(preErr.message),
			`expected pre-race "not indexed" (no index), got: ${preErr?.message}`
		);

		// Reload schema to mark path as @indexed. This kicks off runIndexing over the
		// existing rows and leaves Rule.indexingOperation as the in-flight promise.
		await loadGQLSchema(`
			type Rule @table {
				id: ID! @primaryKey
				path: String @indexed
				target: String
			}
		`);

		const results = { landed: 0, dup: 0, notIndexed: 0, other: 0, otherMsgs: new Map() };

		for (let i = 0; i < N; i++) {
			const lookup = `/p/${i}`;
			let searchErr;
			const hits = [];
			try {
				const iter = Rule.search({
					allowFullScan: false,
					conditions: [{ attribute: 'path', value: lookup }],
				});
				for await (const row of iter) hits.push(row);
			} catch (e) {
				searchErr = e;
			}

			if (searchErr) {
				if (/not indexed yet/i.test(searchErr.message)) results.notIndexed++;
				else {
					results.other++;
					results.otherMsgs.set(searchErr.message, (results.otherMsgs.get(searchErr.message) || 0) + 1);
				}
				continue;
			}
			if (hits.length > 0) {
				results.dup++;
				continue;
			}
			try {
				await transaction((ctx) => Rule.put({ id: `upload-${i}`, path: lookup, target: `/t-new/${i}` }, ctx));
				results.landed++;
			} catch (e) {
				results.other++;
				results.otherMsgs.set(e.message, (results.otherMsgs.get(e.message) || 0) + 1);
			}
		}

		await Rule.indexingOperation;

		// If runIndexing was not in flight when the loop ran, this assertion fails and
		// signals that the race window was missed (test conditions need tuning) rather
		// than that the behavior changed.
		assert.ok(
			results.notIndexed > 0,
			`Expected at least one search to hit "not indexed yet" while runIndexing was in flight. ` +
				`Got 0; the race window was missed. ` +
				`Counters: notIndexed=${results.notIndexed} dup=${results.dup} landed=${results.landed} other=${results.other}.`
		);

		// After indexingOperation resolves, every search must succeed and return the seeded
		// row, confirming that the "not indexed yet" state is strictly transient.
		const postIter = Rule.search({
			allowFullScan: false,
			conditions: [{ attribute: 'path', value: '/p/0' }],
		});
		const postHits = [];
		for await (const row of postIter) postHits.push(row);
		assert.equal(postHits.length, 1, 'after indexingOperation resolves, the indexed search must return the seeded row');
	});
});
