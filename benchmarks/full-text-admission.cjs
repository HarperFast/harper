const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const { setupTestDBPath } = require('../unitTests/testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { setFullTextNativeBindingForTests, fullTextDerivedIndexReadiness } = require('#src/resources/derivedIndexes');
const { FullTextNativeTestBinding } = require('../unitTests/resources/fullTextNativeTestBinding');
const { waitFor } = require('../unitTests/waitFor');
describe('full-text Table admission benchmark', function () {
	this.timeout(120000);
	it('measures fresh requests with restricted field permissions', async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const binding = new FullTextNativeTestBinding();
		setFullTextNativeBindingForTests({ binding });
		const tables = [];
		try {
			for (const width of [2, 16]) {
				const database = 'admission-bench-' + process.pid + '-' + width;
				const names = Array.from({ length: width }, (_, i) => 'field' + i);
				const Product = table({
					database,
					table: 'Product',
					audit: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						...names.map((name) => ({ name, type: 'String' })),
					],
					fullTextIndexes: [
						{
							name: 'search',
							fields: names.map((name) => ({ name, weight: 1 })),
							analyzer: 'english@2',
							stopWords: true,
							positions: true,
							surfaceTerms: true,
							synonyms: [],
						},
					],
				});
				tables.push(Product);
				await Product.put('one', Object.fromEntries(names.map((name) => [name, 'widget'])));
				await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30000);
				const context = {
					user: {
						role: {
							permission: {
								[database]: {
									tables: {
										Product: {
											read: true,
											attribute_permissions: [
												{ attribute_name: 'id', read: true },
												...names.map((attribute_name) => ({ attribute_name, read: true })),
											],
										},
									},
								},
							},
						},
					},
				};
				const scenarios = [];
				for (const count of [0, 1, 32, 127])
					for (const explicit of [false, true]) {
						const make = () => ({
							conditions: [
								{
									attribute: 'search',
									comparator: 'matches',
									value: 'widget',
									...(count
										? {
												should: Array.from({ length: count }, () => ({
													comparator: 'matches',
													value: 'widget',
													...(explicit ? { fields: names.slice() } : {}),
												})),
											}
										: {}),
								},
							],
							select: ['id'],
							checkPermission: true,
						});
						const run = () => {
							const target = make();
							const out = Product._prepareQueryConditions(target.conditions, 'and', target, context);
							assert.strictEqual(out.conditions[0].should?.length ?? 0, count);
						};
						for (let i = 0; i < 1000; i++) run();
						scenarios.push({ count, explicit, run, samples: [] });
					}
				for (let round = 0; round < 5; round++)
					for (const x of round % 2 ? [...scenarios].reverse() : scenarios) {
						global.gc?.();
						const begin = performance.now();
						for (let i = 0; i < 5000; i++) x.run();
						x.samples.push(((performance.now() - begin) * 1000) / 5000);
					}
				for (const x of scenarios)
					console.log(
						'ADMISSION ' +
							JSON.stringify({
								node: process.version,
								platform: process.platform,
								arch: process.arch,
								gcExposed: typeof global.gc === 'function',
								width,
								count: x.count,
								explicit: x.explicit,
								iterations: 5000,
								rounds: 5,
								medianUs: [...x.samples].sort((a, b) => a - b)[2],
								samplesUs: x.samples,
							})
					);
			}
		} finally {
			for (const Product of tables) {
				const runtime = Product.derivedIndexRuntime;
				Product.derivedIndexRuntime = undefined;
				await runtime?.close();
			}
			setFullTextNativeBindingForTests(undefined);
		}
	});
});
