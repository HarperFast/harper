const assert = require('node:assert');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { setupTestDBPath } = require('../testUtils.js');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { loadComponent } = require('#src/components/componentLoader');
const { statusForComponent, internal: statusInternal } = require('#src/components/status/index');
const { Resources } = require('#src/resources/Resources');
const { table, databases } = require('#src/resources/databases');
const { removeBranches } = require('#src/resources/branchDatabase');
const { scopedBindings } = require('#src/security/jsLoader');
const { server } = require('#src/server/Server');
const { setMainIsWorker, getWorkerIndex } = require('#js/server/threads/manageThreads');

const BASE = 'loaderbranchbase';
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('componentLoader branch scope ownership', () => {
	let directory;
	let resources;
	let Source;
	let mainWasWorker;

	before(async () => {
		mainWasWorker = getWorkerIndex() === 0;
		setupTestDBPath();
		setMainIsWorker(true);
		Source = table({
			database: BASE,
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Source.put({ id: 'seed' });
	});
	after(() => setMainIsWorker(mainWasWorker));

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'loader-branches-'));
		resources = new Resources();
	});

	afterEach(async () => {
		await removeBranches();
		statusInternal.componentStatusRegistry.reset();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function moduleAt(dir, config = '') {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'config.yaml'), `pluginModule: probe.js\nrunOnMainThread: true\n${config}`);
		await writeFile(join(dir, 'probe.js'), `export { databases } from 'harper';\n`);
	}

	(isLMDB ? it.skip : it)('prepares a supplied application scope and preserves its map on nested loads', async () => {
		await moduleAt(directory);
		const applicationScope = new ApplicationScope('package-owner', resources, server);
		const parent = await loadComponent(directory, resources, 'test', {
			applicationScope,
			appName: 'package-owner',
			branchedDatabases: [BASE],
		});
		const branches = applicationScope.branches;
		assert.ok(branches?.has(BASE), 'the supplied scope must receive its declared fork');
		const Records = parent.databases[BASE].Records;
		assert.strictEqual(Records, branches.get(BASE).tables.Records);
		assert.ok(await Records.get('seed'));
		assert.notStrictEqual(Records, Source);

		const childDir = join(directory, 'child');
		await moduleAt(childDir);
		const child = await loadComponent(childDir, resources, 'test', {
			applicationScope,
			appName: 'package-owner',
		});
		assert.strictEqual(applicationScope.branches, branches, 'a nested load must not replace the branch map');
		assert.strictEqual(child.databases[BASE].Records, Records);
		await child.databases[BASE].Records.put({ id: 'nested' });
		assert.ok(await Records.get('nested'));
		assert.strictEqual(await Source.get('nested'), null);
	});

	it('fails before importing a module when its supplied scope cannot prepare the declared branch', async () => {
		await moduleAt(directory);
		const applicationScope = new ApplicationScope('missing-branch', resources, server);
		const loaded = await loadComponent(directory, resources, 'test', {
			applicationScope,
			appName: 'missing-branch',
			branchedDatabases: ['missingbranchdatabase'],
		});
		assert.ok(loaded === undefined, 'the plugin module must never import');
		assert.strictEqual(applicationScope.branches, undefined);
		assert.ok(resources.get(''), 'a failed load must register an error resource');
	});

	it('still refuses branchedDatabases in the application config', async () => {
		await moduleAt(directory, `branchedDatabases: [${BASE}]\n`);
		const applicationScope = new ApplicationScope('misplaced-branch', resources, server);
		assert.strictEqual(await loadComponent(directory, resources, 'test', { applicationScope }), undefined);
		const status = statusForComponent(basename(directory)).get();
		assert.strictEqual(status.status, 'error');
		assert.strictEqual(applicationScope.branches, undefined);
	});

	it('imports with the base binding when a supplied native scope has no branch declaration', async () => {
		await moduleAt(directory);
		const applicationScope = new ApplicationScope('unbranched-native', resources, server);
		applicationScope.mode = 'native';
		const loaded = await loadComponent(directory, resources, 'test', { applicationScope });
		assert.strictEqual(resources.size, 0, 'an absent declaration must not fail native loading');
		assert.strictEqual(applicationScope.branches, undefined);
		assert.ok(loaded?.databases === databases, 'the native module must import with the base databases binding');
		assert.strictEqual(scopedBindings(applicationScope).databases, databases);
	});
});
