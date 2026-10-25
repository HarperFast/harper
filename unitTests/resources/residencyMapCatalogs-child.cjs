const exit = process.exit.bind(process);
const assert = require('node:assert');
const { dirname, join } = require('node:path');
const { mkdirSync } = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, HDB_SETTINGS_NAMES } = require('#src/utility/hdbTerms');
const root = process.argv[2];
mkdirSync(join(root, 'database'), { recursive: true });
env.setProperty(HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
env.setProperty(CONFIG_PARAMS.STORAGE_PATH, join(root, 'database'));
env.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, true);
const { table, resetDatabases, databases } = require('#src/resources/databases');
const { initializeResidencySlots, getResidencyMapTable, readResidencyMap } = require('#src/resources/residencyMaps');
const { createResidencyMap } = require('#src/resources/residencyPolicy');
const { server } = require('#src/server/Server');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

(async () => {
	setMainIsWorker(true);
	env.setProperty(CONFIG_PARAMS.REPLICATION_SHARD, 0);
	env.setProperty(CONFIG_PARAMS.REPLICATION_SHARDS, [0, 1]);
	server.shards = new Map([
		[0, [{ name: server.hostname }]],
		[1, [{ name: 'other-owner' }]],
	]);
	env.setProperty(CONFIG_PARAMS.DATABASES, {});
	const attributes = [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'tag', indexed: true },
	];
	if (process.argv[3] === 'worker-configured') {
		const { Worker, parentPort } = require('node:worker_threads');
		const { once } = require('node:events');
		const { getDatabases } = require('#src/resources/databases');
		env.setProperty(CONFIG_PARAMS.DATABASES, { worker_catalog: { tables: { Placed: { path: join(root, 'extra') } } } });
		if (parentPort) {
			const loaded = getDatabases().worker_catalog;
			assert.ok(loaded.Ordinary);
			assert.equal(loaded.Placed, undefined, 'the worker scans before declaration');
			parentPort.postMessage('ready');
			await once(parentPort, 'message');
			assert.equal(loaded.Placed, undefined, 'the worker has not processed the schema event');
			const moved = createResidencyMap('worker_catalog', 2, [{ start: 0, end: 2, shard: 1 }], 2);
			await assert.rejects(async () => getResidencyMapTable().put('worker_catalog', moved), /migration|reassign|move/i);
			assert.equal(readResidencyMap('worker_catalog').version, 1);
			exit(0);
		}
		const Ordinary = table({ database: 'worker_catalog', table: 'Ordinary', audit: true, attributes });
		await Ordinary.put('ordinary', { id: 'ordinary', tag: 'anchor' });
		await initializeResidencySlots({ database: 'worker_catalog', slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const worker = new Worker(__filename, { argv: [root, 'worker-configured'] });
		const completion = once(worker, 'exit');
		await once(worker, 'message');
		const Placed = table({
			database: 'worker_catalog',
			table: 'Placed',
			audit: true,
			residency: { slots: 2, slotFrom: '0' },
			attributes,
		});
		assert.strictEqual(Placed.dbisDB, Ordinary.dbisDB, 'runtime declaration reuses the logical database root');
		await Placed.put('placed', { id: 'placed', tag: 'resident' });
		worker.postMessage('validate');
		const [code] = await completion;
		assert.equal(code, 0);
		console.log('multi-root map fence passed');
		exit(0);
	}
	const ordinary = table({ database: 'a_catalog', table: 'Ordinary', audit: true, attributes });
	await initializeResidencySlots({ database: 'joined_catalogs', slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
	await initializeResidencySlots({ database: 'b_catalog', slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
	const placed = table({
		database: 'b_catalog',
		table: 'Placed',
		audit: true,
		residency: { slots: 2, slotFrom: '0' },
		attributes,
	});
	await ordinary.put('ordinary', { id: 'ordinary', tag: 'anchor' });
	await placed.put('placed', { id: 'placed', tag: 'resident' });
	env.setProperty(CONFIG_PARAMS.DATABASES, {
		joined_catalogs: { path: dirname(ordinary.primaryStore.rootStore.path) },
	});
	resetDatabases();
	const joined = databases.joined_catalogs;
	assert.ok(joined.Ordinary && joined.Placed, 'the configured database loads both physical catalogs');
	assert.notStrictEqual(joined.Ordinary.dbisDB, joined.Placed.dbisDB, 'the fixture must span native roots');
	assert.strictEqual(Object.values(joined)[0], joined.Ordinary, 'the first catalog has no declarative table');
	const map = createResidencyMap('joined_catalogs', 2, [{ start: 0, end: 2, shard: 1 }], 2);
	await assert.rejects(async () => getResidencyMapTable().put('joined_catalogs', map), /migration|reassign|move/i);
	assert.equal(readResidencyMap('joined_catalogs').version, 1, 'the active placement stays unchanged');
	console.log('multi-root map fence passed');
	exit(0);
})().catch((error) => {
	console.error(error);
	exit(1);
});
