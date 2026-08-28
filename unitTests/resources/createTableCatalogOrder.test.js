require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
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

	it('a catalog scan on another thread skips the table mid-create and loads it complete afterwards', async function () {
		// LMDB holds an environment-wide write transaction for the create, so another thread's scan blocks
		// until it commits instead of ever observing the catalog; only RocksDB exposes the row-by-row writes
		if (!(database({ database: 'test', table: null }) instanceof RocksDatabase)) this.skip();
		const tableName = 'CatalogScanTest';
		const Seed = table({
			table: 'CatalogScanSeed',
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		const phase = new Int32Array(new SharedArrayBuffer(4));
		const ack = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(__dirname + '/createTableCatalogOrder-thread.js', {
			workerData: { phase, ack, tableName, addPorts: [] },
		});
		const scans = {};
		const failure = new Promise((_, reject) => worker.once('error', reject));
		const scanned = (type) =>
			Promise.race([
				failure,
				new Promise((resolve) => {
					if (scans[type]) return resolve(scans[type]);
					worker.on('message', function onMessage(message) {
						if (message.type !== type) return;
						worker.off('message', onMessage);
						resolve(message);
					});
				}),
			]);
		worker.on('message', (message) => (scans[message.type] = message));
		const catalogPrototype = Object.getPrototypeOf(Seed.dbisDB);
		const patched = [];
		let pausedStatus;
		for (const method of ['put', 'putSync']) {
			const original = catalogPrototype[method];
			if (typeof original !== 'function') continue;
			catalogPrototype[method] = function (key, ...rest) {
				const result = original.call(this, key, ...rest);
				// the first attribute row is on disk: hand the catalog to the other thread and block this one
				if (key === `${tableName}/name` && pausedStatus === undefined) {
					Atomics.store(phase, 0, 1);
					Atomics.notify(phase, 0);
					pausedStatus = Atomics.wait(ack, 0, 0, 30000);
				}
				return result;
			};
			patched.push([method, original]);
		}
		try {
			table({
				table: tableName,
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'name', type: 'String' },
					{ name: 'tag', type: 'String', indexed: true },
				],
			});
			for (const [method, original] of patched) catalogPrototype[method] = original;
			assert.strictEqual(pausedStatus, 'ok', `the other thread never finished its mid-create scan (${pausedStatus})`);
			Atomics.store(phase, 0, 2);
			Atomics.notify(phase, 0);
			const midCreate = await scanned('mid-create');
			assert.strictEqual(
				midCreate.loaded,
				false,
				`a scan during the create must not load the table, got attributes ${midCreate.attributes}`
			);
			assert.strictEqual(midCreate.updateTableEvents, 0, 'a scan during the create must not announce the table');
			const afterCreate = await scanned('after-create');
			assert.deepStrictEqual(
				[...afterCreate.attributes].sort(),
				['id', 'name', 'tag'],
				'the scan after the create must load the complete attribute list'
			);
			assert.ok(afterCreate.updateTableEvents >= 1, 'the scan after the create must announce the complete table');
		} finally {
			for (const [method, original] of patched) catalogPrototype[method] = original;
			await worker.terminate();
		}
	});
});
