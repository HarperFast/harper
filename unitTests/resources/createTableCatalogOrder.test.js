require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, databases, table } = require('#src/resources/databases');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const storageReclamation = require('#src/server/storageReclamation');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A catalog scan on another worker thread loads a table only once its primary row exists, so that row
// must land after every attribute row or the scan builds, and replication announces, a partial table.
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

	it('a create that fails before its primary row registers nothing, releases its stores, and can be retried', async () => {
		const tableName = 'CatalogFailTest';
		const Seed = table({
			table: 'CatalogFailSeed',
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		// table() annotates the attribute objects it is given, so every attempt gets its own copy
		const definition = () => ({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'tag', type: 'String', indexed: true },
			],
		});
		const catalogPrototype = Object.getPrototypeOf(Seed.dbisDB);
		const writes = [];
		const patched = [];
		let failNextTableIdWrite = true;
		let failNextTagRow = true;
		// Table.cleanup() is the only caller of this, so a call is proof the failed create released its callbacks
		const releasedReclamationHandlers = [];
		const originalRemoveHandler = storageReclamation.removeStorageReclamationHandler;
		storageReclamation.removeStorageReclamationHandler = function (path, handler) {
			releasedReclamationHandlers.push(path);
			return originalRemoveHandler.call(this, path, handler);
		};
		for (const method of ['put', 'putSync']) {
			const original = catalogPrototype[method];
			if (typeof original !== 'function') continue;
			catalogPrototype[method] = function (key, ...rest) {
				// the primary store is open but makeTable() has not run when the next table id is claimed
				if (key === Symbol.for('next-table-id') && failNextTableIdWrite) {
					failNextTableIdWrite = false;
					throw new Error('injected table id write failure');
				}
				// the index store for 'tag' is already open when its row is written
				if (key === `${tableName}/tag` && failNextTagRow) {
					failNextTagRow = false;
					throw new Error('injected catalog write failure');
				}
				if (typeof key === 'string' && key.startsWith(`${tableName}/`)) writes.push(key);
				return original.call(this, key, ...rest);
			};
			patched.push([method, original]);
		}
		let Retried;
		try {
			assert.throws(() => table(definition()), /injected table id write failure/);
			assert.strictEqual(
				databases.test[tableName],
				undefined,
				'a create that fails before makeTable must not register the class'
			);
			assert.strictEqual(releasedReclamationHandlers.length, 0, 'nothing was registered before makeTable');
			// makeTable() itself throws here, after registering its callbacks
			assert.throws(() => table({ ...definition(), expiration: -1 }), /Expiration can not be negative/);
			assert.strictEqual(
				databases.test[tableName],
				undefined,
				'a create that fails inside makeTable must not register the class'
			);
			assert.strictEqual(
				releasedReclamationHandlers.length,
				1,
				'a failure inside makeTable must release its callbacks'
			);
			assert.throws(() => table(definition()), /injected catalog write failure/);
			assert.strictEqual(databases.test[tableName], undefined, 'a failed create must not register the class');
			assert(!writes.includes(`${tableName}/`), `a failed create must not write the primary row: ${writes}`);
			assert.strictEqual(releasedReclamationHandlers.length, 2, 'a failed create must release its callbacks');
			if (Seed.dbisDB.committed) await Seed.dbisDB.committed;
			assert.strictEqual(
				Seed.dbisDB.getSync(`${tableName}/name`),
				undefined,
				'a failed create must remove the rows it wrote'
			);
			Retried = table(definition());
		} finally {
			storageReclamation.removeStorageReclamationHandler = originalRemoveHandler;
			for (const [method, original] of patched) catalogPrototype[method] = original;
		}
		assert.strictEqual(databases.test[tableName], Retried, 'the retry must register the class');
		assert.deepStrictEqual(
			Retried.attributes.map((attribute) => attribute.name).sort(),
			['id', 'name', 'tag'],
			'the retry must declare every attribute'
		);
		assert(Retried.indices.tag, 'the retry must open the index');
		if (Retried.dbisDB.committed) await Retried.dbisDB.committed;
		const primaryRow = Retried.dbisDB.getSync(`${tableName}/`);
		assert(primaryRow, 'the retry must write the primary row');
		assert.strictEqual(primaryRow.schemaDefined, true, 'the primary row must carry the schemaDefined declaration');
		// the failed attempt closed this column family on RocksDB; the retry must have reopened a usable one
		await Retried.primaryStore.put('retried', { id: 'retried', name: 'after retry' });
		assert.strictEqual(
			(await Retried.primaryStore.get('retried'))?.name,
			'after retry',
			'the retried primary store must serve traffic'
		);
		assert.strictEqual(
			writes[writes.length - 1],
			`${tableName}/`,
			`primary row must still be the last write: ${writes}`
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
		// the other thread holds a class from a dropped generation of the same name when the recreate starts
		const FirstGeneration = table({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'old', type: 'String' },
			],
		});
		Atomics.store(phase, 0, 1);
		Atomics.notify(phase, 0);
		const firstGeneration = await scanned('first-generation');
		assert.deepStrictEqual(
			[...firstGeneration.attributes].sort(),
			['id', 'old'],
			'the other thread must hold the first generation'
		);
		await FirstGeneration.dropTable();
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
					Atomics.store(phase, 0, 2);
					Atomics.notify(phase, 0);
					pausedStatus = Atomics.wait(ack, 0, 1, 30000);
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
			Atomics.store(phase, 0, 3);
			Atomics.notify(phase, 0);
			const midCreate = await scanned('mid-create');
			assert.strictEqual(
				midCreate.loaded,
				false,
				`a scan during the create must load neither the new table nor the dropped generation, got attributes ${midCreate.attributes}`
			);
			assert.strictEqual(midCreate.updateTableEvents, 0, 'a scan during the create must not announce the table');
			assert.strictEqual(midCreate.attributeRowVisible, true, 'the other thread must have seen the attribute row');
			assert.strictEqual(midCreate.primaryRowVisible, false, 'the primary row must not exist yet');
			const afterCreate = await scanned('after-create');
			assert.deepStrictEqual(
				[...afterCreate.attributes].sort(),
				['id', 'name', 'tag'],
				'the scan after the create must load the complete attribute list'
			);
			assert.ok(afterCreate.updateTableEvents >= 1, 'the scan after the create must announce the complete table');
			assert.strictEqual(afterCreate.primaryRowVisible, true, 'the primary row must exist after the create');
		} finally {
			for (const [method, original] of patched) catalogPrototype[method] = original;
			await worker.terminate();
		}
	});
});
