require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A catalog scan on another worker thread (resetDatabases from any schema-change signal) loads a
// table only once its primary row exists, so that row must land after every attribute row; otherwise
// the scan builds - and replication announces to peers - a Table with a partial attribute list.
describe('create table catalog write order', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('writes the primary key row after every attribute row', () => {
		const Seed = table({
			table: 'CatalogOrderSeed',
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		// table() opens a fresh catalog handle for every new table, so intercept the class, not the instance
		const catalogPrototype = Object.getPrototypeOf(Seed.dbisDB);
		const writes = [];
		const patched = [];
		for (const method of ['put', 'putSync']) {
			const original = catalogPrototype[method];
			if (typeof original !== 'function') continue;
			catalogPrototype[method] = function (key, ...rest) {
				if (typeof key === 'string' && key.startsWith('CatalogOrderTest/')) writes.push(key);
				return original.call(this, key, ...rest);
			};
			patched.push([method, original]);
		}
		try {
			table({
				table: 'CatalogOrderTest',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'name', type: 'String' },
					{ name: 'tag', type: 'String', indexed: true },
				],
			});
		} finally {
			for (const [method, original] of patched) catalogPrototype[method] = original;
		}
		assert(writes.includes('CatalogOrderTest/name'), `attribute row for 'name' was not written: ${writes}`);
		assert(writes.includes('CatalogOrderTest/tag'), `attribute row for 'tag' was not written: ${writes}`);
		assert.strictEqual(
			writes.filter((key) => key === 'CatalogOrderTest/').length,
			1,
			`primary row must be written exactly once: ${writes}`
		);
		assert.strictEqual(
			writes[writes.length - 1],
			'CatalogOrderTest/',
			`primary row must be the last catalog write of the create: ${writes}`
		);
	});
});
