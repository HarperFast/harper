const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { searchByIndex } = require('#src/resources/search');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// searchByIndex takes its optional tail as a named options object (#2165). These assert the options
// are actually read off that object: a caller that reverts to positional arguments would hand
// `false` in where the options belong, and destructuring it yields `allowFullScan === undefined` —
// silently turning a rejected full scan into a permitted one.
describe('searchByIndex options object (#2165)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let T;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'SearchByIndexOptionsTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'indexedName', indexed: true },
				{ name: 'unindexedName' },
			],
		});
		await T.put(1, { indexedName: 'a', unindexedName: 'x' });
		await T.put(2, { indexedName: 'b', unindexedName: 'y' });
	});

	after(() => {
		T.dropTable();
	});

	it('rejects an unindexed attribute when allowFullScan is false in the options object', () => {
		assert.throws(
			() =>
				searchByIndex({ attribute: 'unindexedName', value: 'x' }, undefined, false, T, {
					allowFullScan: false,
				}),
			/not indexed/,
			'allowFullScan must be read from the named option'
		);
	});

	it('keeps the permissive defaults when the options object is omitted entirely', async () => {
		const ids = [];
		for await (const entry of searchByIndex({ attribute: 'unindexedName', value: 'x' }, undefined, false, T)) {
			ids.push(entry?.key ?? entry);
		}
		assert.deepStrictEqual(ids, [1], 'omitting options must full-scan, not inherit allowFullScan: false');
	});
});
