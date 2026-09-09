require('../testUtils');
const assert = require('assert');
const { existsSync } = require('node:fs');
const { mkdir, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, database, BRANCH_ROOT_DIR, resolveBranchPath } = require('#src/resources/databases');
const { getOrCreateBranch, removeBranches } = require('#src/resources/branchDatabase');
const { replayLogs } = require('#src/resources/replayLogs');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const { writeFileSync: _writeFileSync, mkdirSync: _mkdirSync } = require('node:fs');
const { join: _join } = require('node:path');
const { getBlobPathsForDatabaseName: _blobRoots } = require('#src/resources/blob');

/**
 * Finish a branch that a test built by hand so it reads as one materialization published: the
 * completion marker naming the blob roots, and those roots present. Without it such a branch is
 * (correctly) refused as a real store carrying no marker.
 */
function publishHandBuiltBranch(branchPath, appName, baseName) {
	const blobRoots = _blobRoots(`${appName.length}_${appName}__${baseName}`);
	for (const root of blobRoots) _mkdirSync(root, { recursive: true });
	_writeFileSync(_join(branchPath, '.branch-complete'), JSON.stringify({ blobRoots }));
}

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const describeUnlessLmdb = isLMDB ? describe.skip : describe;
const itUnlessLmdb = isLMDB ? it.skip : it;
const itOnLmdb = isLMDB ? it : it.skip;

describeUnlessLmdb('branch lifecycle (harper#643)', () => {
	let Source;
	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		Source = table({
			table: 'LifecycleSource',
			database: 'lifebase',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'note' }],
		});
		await Source.put({ id: 'a', note: 'base' });
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('creates a branch that serves the base rows and lives under the reserved root', async function () {
		const branch = await getOrCreateBranch('lifebase', 'appA');

		const row = await branch.tables.LifecycleSource.get('a');
		assert.strictEqual(row?.note, 'base');
		const expected = resolveBranchPath('lifebase', 'appA');
		assert.ok(existsSync(expected), `expected the branch at ${expected}`);
		assert.ok(expected.includes(BRANCH_ROOT_DIR), 'branches belong under the reserved root');
	});

	it('gives concurrent callers the same branch rather than racing two checkpoints', async function () {
		// Every worker thread loads the same applications, so this is the ordinary case, not an edge one.
		const [first, second, third] = await Promise.all([
			getOrCreateBranch('lifebase', 'appA'),
			getOrCreateBranch('lifebase', 'appA'),
			getOrCreateBranch('lifebase', 'appA'),
		]);
		assert.strictEqual(first, second);
		assert.strictEqual(second, third);
	});

	it('keeps two applications on separate branches', async function () {
		const a = await getOrCreateBranch('lifebase', 'appA');
		const b = await getOrCreateBranch('lifebase', 'appB');

		await a.tables.LifecycleSource.put({ id: 'only-a', note: 'from A' });

		assert.ok(await a.tables.LifecycleSource.get('only-a'));
		assert.ok(
			!(await b.tables.LifecycleSource.get('only-a')),
			"one application's writes must not be visible to another's branch"
		);
		assert.ok(!(await databases.lifebase.LifecycleSource.get('only-a')), 'nor to the base');
	});

	it('leaves the base untouched and unaware', async function () {
		const branch = await getOrCreateBranch('lifebase', 'appA');
		await branch.tables.LifecycleSource.put({ id: 'a', note: 'changed in branch' });

		const base = await databases.lifebase.LifecycleSource.get('a');
		assert.strictEqual(base.note, 'base', 'a branch write must not reach the base');
	});

	it('removes its directories on teardown', async function () {
		await getOrCreateBranch('lifebase', 'appA');
		const path = resolveBranchPath('lifebase', 'appA');
		assert.ok(existsSync(path));

		await removeBranches();
		assert.strictEqual(existsSync(path), false, 'a branch does not outlive the process');
	});

	it('refuses DDL through a branch, leaving the base schema intact', async function () {
		const branch = await getOrCreateBranch('lifebase', 'appA');
		const baseTableClass = databases.lifebase.LifecycleSource;

		// A branch's Table classes carry the BASE's logical database name so app code resolves
		// unchanged, which is exactly why a drop through one would delete the live base table.
		await assert.rejects(() => branch.tables.LifecycleSource.dropTable(), /branched database/);
		await assert.rejects(() => branch.tables.LifecycleSource.addAttributes([{ name: 'added' }]), /branched database/);
		await assert.rejects(() => branch.tables.LifecycleSource.removeAttributes(['note']), /branched database/);

		assert.strictEqual(
			databases.lifebase.LifecycleSource,
			baseTableClass,
			'the base Table class must survive a refused drop'
		);
		assert.ok(await databases.lifebase.LifecycleSource.get('a'), 'and its rows must still be readable');
		assert.ok(await branch.tables.LifecycleSource.get('a'), 'the branch itself stays usable for reads');
		await branch.tables.LifecycleSource.put({ id: 'writes-still-work', note: 'x' });
	});

	it('leaves DDL on a real database unaffected', async function () {
		// The gate must key on being a branch, not on anything the base shares with it.
		assert.doesNotThrow(() => databases.lifebase.LifecycleSource.assertSchemaMutable('drop a table'));
	});

	it('rejects a path segment that would escape the reserved root', function () {
		assert.throws(() => resolveBranchPath('lifebase', '..'), /Invalid application name/);
		assert.throws(() => resolveBranchPath('a/b', 'appA'), /Invalid database name/);
	});

	it('settles an elected replay instead of hanging: resolve on completion, reject on a held lock', async function () {
		// The elected replay promise is awaited inside the branch claim's CREATING window, so it must
		// always settle — an unresolved promise would wedge the claim and every waiting thread. Uses
		// its own database: the replay permanently takes the store's replay lock and applies its log
		// tail, which must not become shared suite state on lifebase.
		table({
			table: 'ReplayProbe',
			database: 'replaybase',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const rootStore = database({ database: 'replaybase', table: undefined });
		await replayLogs(rootStore, databases.replaybase, true);
		// The completed replay holds the store's replay lock forever (by design: replay runs once per
		// store per process), so a second elected call must reject rather than hang or run again.
		await assert.rejects(() => replayLogs(rootStore, databases.replaybase, true), /replay lock/);
	});

	it('a mid-flight strict replay failure rejects — and still rejects after releasing the lock', async function () {
		// Releasing the lock wakes tryLock callbacks, including the holder's own resolve(); the
		// rejection must win the settle or a failed replay reads as success and READY publishes an
		// incomplete store. A stub store drives the real replay loop into its per-entry failure path.
		let unlocked = false;
		const queued = [];
		const poisonedTable = {
			tableId: 7,
			getResource() {
				throw new Error('poisoned resource');
			},
		};
		const stubStore = {
			databaseName: 'stub',
			tryLock(key, onUnlocked) {
				queued.push(onUnlocked);
				return true;
			},
			unlock() {
				unlocked = true;
				for (const onUnlocked of queued) onUnlocked();
				return true;
			},
			auditStore: {
				getRange() {
					return Object.assign(
						[{ type: 'put', tableId: 7, version: 1, extendedType: 17, getValue: () => ({ id: 1 }) }],
						{ corruptFrameStop: { breaks: 0, truncatedVersions: new Set() } }
					);
				},
			},
		};
		await assert.rejects(() => replayLogs(stubStore, { Poisoned: poisonedTable }, true), /poisoned resource/);
		assert.strictEqual(unlocked, true, 'a failed strict replay must release the lock for the retry');
	});

	it('an elected replay rejects on a mid-log break even when every readable entry replayed cleanly', async function () {
		// A mid-log break can strand entries this range never attributes to any yielded version (a
		// log that breaks before yielding anything truncates no transaction), so the branch claim
		// must not go READY just because truncatedVersions came back empty and every entry it could
		// read committed cleanly. It rejects on midLogBreak itself.
		let unlocked = false;
		const queued = [];
		const healthyTable = {
			tableId: 7,
			getResource() {
				return { _writeUpdate() {}, save() {} };
			},
		};
		const stubStore = {
			databaseName: 'stub-midlog',
			tryLock(key, onUnlocked) {
				queued.push(onUnlocked);
				return true;
			},
			unlock() {
				unlocked = true;
				for (const onUnlocked of queued) onUnlocked();
				return true;
			},
			auditStore: {
				getRange() {
					return Object.assign(
						[{ type: 'put', tableId: 7, version: 1, extendedType: 17, getValue: () => ({ id: 1 }) }],
						{ corruptFrameStop: { breaks: 1, truncatedVersions: new Set(), midLogBreak: true } }
					);
				},
			},
		};
		await assert.rejects(() => replayLogs(stubStore, { Healthy: healthyTable }, true), /mid-log corrupt/);
		assert.strictEqual(unlocked, true, 'a rejected elected replay must still release the lock for a retry');
	});

	it('fails the load when the adopted branch cannot replay, then adopts cleanly once it can', async function () {
		// Materialize by hand what a previous boot leaves behind, so this boot's first sight of the
		// branch is the adopt path.
		const branchPath = resolveBranchPath('lifebase', 'appAdopt');
		const staging = `${branchPath}.staging`;
		await rm(staging, { recursive: true, force: true });
		await mkdir(join(branchPath, '..'), { recursive: true });
		await database({ database: 'lifebase', table: undefined }).createCheckpoint(staging);
		await rename(staging, branchPath);
		publishHandBuiltBranch(branchPath, 'appAdopt', 'lifebase');

		// Hold the branch store's replay lock from a second handle on the same directory (handles on
		// one path share the native store, and the lock table lives on it): the elected replay must
		// reject — a strict failure after the winner has already opened the branch.
		const raw = RocksDatabase.open(branchPath);
		try {
			assert.ok(
				raw.tryLock('replayLogs', () => {}),
				'the probe handle must be able to take the lock'
			);
			await assert.rejects(() => getOrCreateBranch('lifebase', 'appAdopt'), /replay lock/);

			// The failed winner must have closed what it opened and released the claim: after the
			// blocker clears, the same process must be able to adopt the same directory.
			raw.unlock('replayLogs');
			const branch = await getOrCreateBranch('lifebase', 'appAdopt');
			assert.ok(await branch.tables.LifecycleSource.get('a'), 'the adopted branch serves the base rows');
		} finally {
			raw.close();
		}
	});

	it('releases the claim when the winner cannot open the branch, so a repaired retry works', async function () {
		// A directory that exists is adopted, so plant one that cannot be opened: the winner must
		// close whatever it opened and release the claim, not leave it wedged in CREATING or READY.
		const path = resolveBranchPath('lifebase', 'appBroken');
		await mkdir(path, { recursive: true });
		await writeFile(join(path, 'CURRENT'), 'not a database\n');
		await assert.rejects(() => getOrCreateBranch('lifebase', 'appBroken'));

		await rm(path, { recursive: true, force: true });
		const branch = await getOrCreateBranch('lifebase', 'appBroken');
		assert.ok(await branch.tables.LifecycleSource.get('a'), 'the retry after repair must serve the base rows');
	});
});

describe('branchedDatabases config (harper#643)', () => {
	let assertBranchedDatabases;
	before(function () {
		({ assertBranchedDatabases } = require('#src/components/Application'));
	});

	it('accepts an absent or empty declaration', function () {
		assert.doesNotThrow(() => assertBranchedDatabases('app', undefined));
		assert.doesNotThrow(() => assertBranchedDatabases('app', []));
		assert.doesNotThrow(() => assertBranchedDatabases('app', ['data', 'other']));
	});

	it('rejects the shapes that would silently mean something else', function () {
		assert.throws(() => assertBranchedDatabases('app', 'data'), /expected an array/);
		assert.throws(() => assertBranchedDatabases('app', [42]), /expected database names/);
		assert.throws(() => assertBranchedDatabases('app', ['']), /expected database names/);
		assert.throws(() => assertBranchedDatabases('app', ['data', 'data']), /listed more than once/);
	});

	it('rejects names that would escape the reserved branch root', function () {
		assert.throws(() => assertBranchedDatabases('app', ['..']), /not a usable database name/);
		assert.throws(() => assertBranchedDatabases('app', ['a/b']), /not a usable database name/);
	});

	it('rejects branching the system database', function () {
		// `system` carries the instance's catalog, users and jobs — a private fork would give the
		// application a divergent view of the instance rather than of its data.
		assert.throws(() => assertBranchedDatabases('app', ['system']), /'system' database cannot be branched/);
	});

	it('accepts `true` as a declaration of every database', function () {
		assert.doesNotThrow(() => assertBranchedDatabases('app', true));
	});
});

describe('branch preparation rejects rather than falling back (harper#643)', () => {
	let prepareBranches;

	before(function () {
		({ prepareBranches } = require('#src/resources/branchDatabase'));
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'PrepSource',
			database: 'prepbase',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('does nothing when no databases are declared', async function () {
		assert.strictEqual((await prepareBranches('app', undefined, 'vm-current-context')).size, 0);
		assert.strictEqual((await prepareBranches('app', [], 'vm-current-context')).size, 0);
	});

	it('refuses the native loader, which cannot carry a scoped databases binding', async function () {
		// Under `native` the branch would be created and then never reached: the application would
		// silently write the base, which is the one outcome this feature exists to prevent.
		await assert.rejects(() => prepareBranches('app', ['prepbase'], 'native'), /native.*module loader/);
	});

	itOnLmdb('refuses the LMDB engine rather than falling back to the base', async function () {
		await assert.rejects(
			() => prepareBranches('app', ['prepbase'], 'vm-current-context'),
			/requires the RocksDB storage engine/
		);
	});

	itUnlessLmdb('refuses a database that does not exist rather than creating one', async function () {
		await assert.rejects(() => prepareBranches('app', ['no-such-db'], 'vm-current-context'), /does not exist/);
	});

	itUnlessLmdb('branches a real database and exposes it under its logical name', async function () {
		const branches = await prepareBranches('app', ['prepbase'], 'vm-current-context');
		assert.ok(branches.get('prepbase')?.tables.PrepSource);
	});

	itUnlessLmdb('`true` branches every database on the instance except `system`', async function () {
		this.timeout(30000);
		table({
			table: 'OtherSource',
			database: 'prepbase2',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});

		const branches = await prepareBranches('allApp', true, 'vm-current-context');

		assert.ok(branches.get('prepbase')?.tables.PrepSource, 'an existing database is branched');
		assert.ok(branches.get('prepbase2')?.tables.OtherSource, 'as is a second one');
		assert.strictEqual(branches.has('system'), false, 'system is excluded even under `true`');
	});

	itUnlessLmdb('`true` is a snapshot of what exists at THIS load, not a standing subscription', async function () {
		this.timeout(30000);
		const branches = await prepareBranches('snapshotApp', true, 'vm-current-context');
		assert.ok(branches.has('prepbase'), 'sanity: the databases that already existed are branched');

		table({
			table: 'LaterSource',
			database: 'preplater',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});

		assert.strictEqual(
			branches.has('preplater'),
			false,
			'a database created after this call must not retroactively appear in it'
		);
	});
});

describe('scoped databases binding (harper#643)', () => {
	// Required lazily, inside the hook: an eager require here pulls the components layer -- and with
	// it resources/dataLoader, which captures its logger at import time -- into memory before
	// dataLoader.test.js can stub the logger factory, silently breaking that suite.
	let scopedBindings, tables;

	before(function () {
		({ scopedBindings } = require('#src/security/jsLoader'));
		({ tables } = require('#src/resources/databases'));
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'BindSource',
			database: 'bindbase',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('gives an unbranched scope the process-wide singletons by identity', function () {
		// This is the overwhelmingly common path and it must be indistinguishable from before: a copy
		// would silently stop reflecting databases created after load.
		const bindings = scopedBindings({});
		assert.strictEqual(bindings.databases, databases);
		assert.strictEqual(bindings.tables, tables);
	});

	itUnlessLmdb('resolves a branched name to the branch and leaves the rest alone', async function () {
		const branch = await getOrCreateBranch('bindbase', 'bindApp');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });

		assert.strictEqual(bindings.databases.bindbase, branch.tables);
		assert.notStrictEqual(bindings.databases.bindbase, databases.bindbase);
		// An unbranched name still resolves to the real database, by identity.
		assert.strictEqual(bindings.databases.lifebase, databases.lifebase);
		// And the global map is untouched.
		assert.notStrictEqual(databases.bindbase, branch.tables);
	});

	itUnlessLmdb('keeps `databases.system` reachable and non-enumerable', async function () {
		// It is defined non-enumerable on the real map, so building the view by copying enumerable
		// properties would drop it and a branched application would lose the system database entirely.
		const branch = await getOrCreateBranch('bindbase', 'bindApp');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });

		assert.ok(bindings.databases.system, 'system must still be reachable');
		assert.strictEqual(
			Object.propertyIsEnumerable.call(bindings.databases, 'system'),
			false,
			'and must stay non-enumerable'
		);
	});

	itUnlessLmdb('keeps showing databases created after the application loaded', async function () {
		// `databases` gains entries at runtime, which is exactly what ensureTable/@table do. A view
		// snapshotted at load would leave a branched application unable to see them.
		const branch = await getOrCreateBranch('bindbase', 'bindApp');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });
		assert.strictEqual(bindings.databases.bindlater, undefined);

		table({ table: 'Later', database: 'bindlater', attributes: [{ name: 'id', isPrimaryKey: true }] });

		assert.ok(bindings.databases.bindlater?.Later, 'a database created after load must be visible');
		assert.strictEqual(bindings.databases.bindbase, branch.tables, 'and the branch still wins for its own name');
	});
});

describeUnlessLmdb('branch rollback is scoped to the failing application (harper#643)', () => {
	const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
	const { dirname, join } = require('node:path');
	let prepareBranches;

	// An occupied branch directory no longer injects a fault: a directory that is already there is a
	// branch to be adopted. These put a FILE where a directory has to be instead.

	/** Fail while materializing — nothing can be written under the application's directory. */
	function failMaterialization(baseName, appName) {
		const parent = dirname(resolveBranchPath(baseName, appName));
		mkdirSync(dirname(parent), { recursive: true });
		writeFileSync(parent, 'not a directory');
		return parent;
	}

	/** Fail while opening — the branch path itself is adopted, then turns out not to be a database. */
	function failBranchOpen(baseName, appName) {
		const path = resolveBranchPath(baseName, appName);
		mkdirSync(path, { recursive: true });
		// Has to read as a COMPLETE branch, or adoption treats it as leftovers and rebuilds from the base
		// instead of failing: a marker naming roots that exist, over something that is not a database.
		writeFileSync(join(path, 'CURRENT'), 'not a database');
		publishHandBuiltBranch(path, appName, baseName);
		return path;
	}

	before(function () {
		({ prepareBranches } = require('#src/resources/branchDatabase'));
		setupTestDBPath();
		setMainIsWorker(true);
		for (const db of ['rollbase1', 'rollbase2']) {
			table({ table: 'Roll', database: db, attributes: [{ name: 'id', isPrimaryKey: true }] });
		}
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('does not close a branch a load already running is using', async function () {
		this.timeout(30000);
		// A branch handle is cached per path for the whole thread, so a second load of the same
		// application shares it. If that second load fails, closing the shared handle would leave the
		// first load's Table classes pointing at a closed store.
		const first = await prepareBranches('reuseApp', ['rollbase1'], undefined);
		const branch = first.get('rollbase1');
		await branch.tables.Roll.put({ id: 'live', note: 'x' });

		failBranchOpen('rollbase2', 'reuseApp');
		await assert.rejects(() => prepareBranches('reuseApp', ['rollbase1', 'rollbase2'], undefined));

		assert.ok(
			await branch.tables.Roll.get('live'),
			"a later failed load must not close the running load's branch handle"
		);
	});

	it('lets a branch be created again after a transient failure', async function () {
		this.timeout(30000);
		const blocked = failMaterialization('rollbase2', 'retryApp');

		await assert.rejects(() => getOrCreateBranch('rollbase2', 'retryApp'));

		// The claim word lives in a buffer the base store shares for the life of the process, so a
		// claim that is not released turns one full disk or lost rename into a branch that can never
		// be created again -- component reload and redeploy included.
		rmSync(blocked, { force: true });
		const branch = await getOrCreateBranch('rollbase2', 'retryApp');
		assert.ok(branch.tables.Roll, 'the retry must actually create the branch');
	});

	it("leaves an already-loaded application's branch open when a later application fails", async function () {
		this.timeout(30000);
		const survivor = await getOrCreateBranch('rollbase1', 'loadedFirst');
		await survivor.tables.Roll.put({ id: 'kept', note: 'x' });

		// Applications load one after another; make the second declared database of a *later* one fail.
		failBranchOpen('rollbase2', 'loadedSecond');

		await assert.rejects(() => prepareBranches('loadedSecond', ['rollbase1', 'rollbase2'], undefined));

		assert.ok(
			await survivor.tables.Roll.get('kept'),
			"a failed application's rollback must not close a loaded application's branch"
		);
		// One branch directory is shared by every worker thread that loaded the application, so the
		// storage must outlive a single thread's failed load: deleting it here would pull RocksDB
		// files out from under a thread that loaded the same application successfully.
		assert.ok(
			existsSync(resolveBranchPath('rollbase1', 'loadedSecond')),
			'a failed load releases its handles but must not delete storage other threads may hold'
		);
	});
});

describeUnlessLmdb('declaring a table from a branched application (harper#2264)', () => {
	const { scopedTableFactory, reloadBranchAt, databaseEventsEmitter } = require('#src/resources/databases');
	const { closeBranchAt, prepareBranches } = require('#src/resources/branchDatabase');
	const APP = 'declApp';
	const BASE = 'declbase';
	const id = { name: 'id', type: 'ID', isPrimaryKey: true };
	// every `updateTable` a global subscriber (replication, analytics) would have seen
	let announced;
	const subscriber = (Table) => announced.push(Table);

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		const Existing = table({
			table: 'Existing',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'note' }],
		});
		await Existing.put({ id: 'base-row', note: 'from the base' });
		// the default database has to exist to be branched
		table({ table: 'DefaultSource', database: 'data', attributes: [id] });
		databaseEventsEmitter.on('updateTable', subscriber);
	});

	after(function () {
		databaseEventsEmitter.off('updateTable', subscriber);
	});

	beforeEach(function () {
		announced = [];
	});

	afterEach(async function () {
		await removeBranches();
	});

	async function branchedFactory() {
		const branches = await prepareBranches(APP, [BASE], 'vm-current-context');
		const branch = branches.get(BASE);
		return { branch, branches, declare: scopedTableFactory(branches) };
	}

	function assertNothingAnnouncedFrom(branch) {
		for (const Table of announced) {
			assert.notStrictEqual(
				Table,
				branch.tables[Table.tableName],
				`a branch class (${Table.tableName}) must never reach a global updateTable subscriber`
			);
		}
	}

	it('hands an unbranched application the global factory itself', function () {
		// This is the path every application that does not branch takes: it has to be the same
		// function, not an equivalent one, so nothing on it changes.
		assert.strictEqual(scopedTableFactory(undefined), table);
		assert.strictEqual(scopedTableFactory(new Map()), table);
	});

	it('declares into the branch and leaves the base without the table', async function () {
		const { branch, declare } = await branchedFactory();

		const Declared = declare({
			table: 'Declared',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'note' }],
		});

		assert.strictEqual(branch.tables.Declared, Declared, 'published into the branch graph');
		assert.strictEqual(databases[BASE].Declared, undefined, 'and never into the base');
		assert.strictEqual(Declared.databaseName, BASE, 'carrying the logical name the application uses');
		assert.strictEqual(
			branch.rootStore.databaseName,
			`${APP.length}_${APP}__${BASE}`,
			"the store keeps its own identity, which the branch's blob roots resolve from"
		);
		await Declared.put({ id: 'a', note: 'in the branch' });
		assert.strictEqual((await Declared.get('a'))?.note, 'in the branch');
		// a class the factory built is a branch class: the base-directed statics stay refused
		await assert.rejects(() => Declared.dropTable(), /branched database/);
		assertNothingAnnouncedFrom(branch);
	});

	it('defaults an unnamed database the way table() does', async function () {
		// `@table` and defineTable omit `database` to mean the default database, so a branch of it has
		// to catch the omitted -- and the empty-string -- case or the most common declaration slips through
		const branches = await prepareBranches(APP, ['data'], 'vm-current-context');
		const branch = branches.get('data');
		const declare = scopedTableFactory(branches);
		const Unnamed = declare({ table: 'Unnamed', attributes: [id] });
		const Empty = declare({ table: 'Empty', database: '', attributes: [id] });
		assert.strictEqual(branch.tables.Unnamed, Unnamed);
		assert.strictEqual(branch.tables.Empty, Empty);
		assert.strictEqual(databases.data.Unnamed, undefined);
		assert.strictEqual(databases.data.Empty, undefined);
	});

	it('routes a database the application did not branch to the global factory, same class and all', async function () {
		const { declare } = await branchedFactory();
		const definition = { table: 'Elsewhere', database: 'declother', attributes: [id] };

		const Elsewhere = declare(definition);

		assert.strictEqual(Elsewhere, databases.declother.Elsewhere);
		assert.strictEqual(Elsewhere, table(definition), 'the identical object the global factory returns');
	});

	it('re-declares a table the base already has in the branch only', async function () {
		const { branch, declare } = await branchedFactory();
		const baseClass = databases[BASE].Existing;
		const baseAttributes = baseClass.attributes.map((attribute) => attribute.name);

		const Evolved = declare({
			table: 'Existing',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'note' }, { name: 'added', type: 'String', indexed: true }],
		});

		assert.strictEqual(Evolved, branch.tables.Existing, 'the alter lands on the branch class');
		assert.notStrictEqual(Evolved, baseClass);
		assert.ok(Evolved.attributes.some((attribute) => attribute.name === 'added'));
		assert.ok(Evolved.indices.added, 'with its index opened on the branch store');
		assert.deepStrictEqual(
			databases[BASE].Existing.attributes.map((attribute) => attribute.name),
			baseAttributes,
			'the base schema is untouched'
		);
		assert.strictEqual(databases[BASE].Existing, baseClass);
		assert.strictEqual((await baseClass.get('base-row'))?.note, 'from the base');
		assert.strictEqual(
			(await Evolved.get('base-row'))?.note,
			'from the base',
			'the branch still serves the checkpoint'
		);
		assertNothingAnnouncedFrom(branch);
	});

	it('persists a declared table in the branch: it is there again after close and reopen', async function () {
		this.timeout(30000);
		const { branch, declare } = await branchedFactory();
		const Persisted = declare({
			table: 'Persisted',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'note' }],
		});
		await Persisted.put({ id: 'kept', note: 'survives the reopen' });

		await closeBranchAt(branch.path);
		const reopened = await getOrCreateBranch(BASE, APP);

		assert.notStrictEqual(reopened, branch, 'sanity: a fresh handle over the same directory');
		assert.ok(reopened.tables.Persisted, 'the catalog in the branch store is the only record needed');
		assert.notStrictEqual(reopened.tables.Persisted, Persisted);
		assert.strictEqual((await reopened.tables.Persisted.get('kept'))?.note, 'survives the reopen');
		assert.strictEqual(databases[BASE].Persisted, undefined);
	});

	it('hydrates a relationship between two branch-declared tables to the branch after reopen', async function () {
		this.timeout(30000);
		const { branch, declare } = await branchedFactory();
		const Target = declare({
			table: 'RelTarget2',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'label' }],
		});
		declare({
			table: 'RelHost2',
			database: BASE,
			schemaDefined: true,
			schemaRelationshipsDefined: true,
			attributes: [
				id,
				{ name: 'targetId', type: 'ID', indexed: {} },
				{
					name: 'target',
					type: 'RelTarget2',
					relationship: { from: 'targetId' },
					relationshipReference: { database: BASE, table: 'RelTarget2' },
					definition: { tableClass: Target },
				},
			],
		});
		assertNothingAnnouncedFrom(branch);

		await closeBranchAt(branch.path);
		const reopened = (await prepareBranches(APP, [BASE], 'vm-current-context')).get(BASE);

		const attribute = reopened.tables.RelHost2.attributes.find((a) => a.name === 'target');
		assert.ok(attribute, 'the persisted relationship comes back with the table');
		const targetClass = (attribute.definition || attribute.elements?.definition)?.tableClass;
		assert.strictEqual(targetClass, reopened.tables.RelTarget2, "resolved within the branch's own graph");
		assertNothingAnnouncedFrom(reopened);
	});

	/** What another thread's create leaves in the shared catalog: the rows, with no class in THIS thread. */
	function createElsewhere(branch, tableName) {
		const catalog = branch.rootStore.dbisDb;
		const tableId = catalog.getSync(Symbol.for('next-table-id')) ?? 1;
		catalog.putSync(Symbol.for('next-table-id'), tableId + 1);
		catalog.putSync(`${tableName}/note`, { name: 'note', attribute: 'note' });
		catalog.putSync(`${tableName}/`, { name: 'id', type: 'ID', isPrimaryKey: true, tableId, schemaDefined: true });
		assert.strictEqual(branch.tables[tableName], undefined, 'sanity: this thread has no class yet');
	}

	it('loads a table another thread created into the branch instead of re-creating it, or creating it in the base', async function () {
		const { branch, declare } = await branchedFactory();
		createElsewhere(branch, 'Raced');

		const Raced = declare({ table: 'Raced', database: BASE, schemaDefined: true, attributes: [id, { name: 'note' }] });

		assert.strictEqual(Raced, branch.tables.Raced, 'the class the reload built is what the declaration returns');
		assert.strictEqual(databases[BASE].Raced, undefined, 'the reload after a lost race must not be the global rescan');
		await Raced.put({ id: 'r', note: 'usable' });
		assert.strictEqual((await Raced.get('r'))?.note, 'usable');
	});

	it('reloads the branch on a schema-change signal that names it, where the branch is open', async function () {
		const { branch, declare } = await branchedFactory();
		const { schema: schemaHandler } = require('#js/server/itc/serverHandlers');
		const ITCEventObject = require('#js/server/itc/utility/ITCEventObject');
		const { SchemaEventMsg } = require('#js/server/threads/itc');
		const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
		// the handler has no way to remove a listener; this one only records into a local array
		const signalled = [];
		schemaHandler.addListener((message) => signalled.push(message));

		// the signal is fire-and-forget from the declaration, so its local delivery is a turn behind
		const { waitFor } = require('../waitFor.js');
		const signalFor = (tableName) => signalled.find((message) => message.table === tableName);

		declare({ table: 'Signalled', database: BASE, schemaDefined: true, attributes: [id] });
		await waitFor(() => signalFor('Signalled'), {
			timeout: 5_000,
			message: 'a declaration into the branch still signals the other threads',
		});
		const forBranch = signalFor('Signalled');
		assert.strictEqual(forBranch.branchPath, branch.path, 'and the signal addresses the branch, not the base');
		assert.strictEqual(forBranch.schema, BASE);

		table({ table: 'GlobalSignalled', database: BASE, schemaDefined: true, attributes: [id] });
		await waitFor(() => signalFor('GlobalSignalled'), { timeout: 5_000, message: 'a base declaration signals' });
		assert.strictEqual(signalFor('GlobalSignalled').branchPath, undefined, 'a base declaration carries no branch path');

		// what a receiving thread does with it: the branch it holds open learns the new table
		createElsewhere(branch, 'FromSignal');
		await schemaHandler(
			new ITCEventObject(
				ITC_EVENT_TYPES.SCHEMA,
				new SchemaEventMsg(process.pid, 'schema-change', BASE, 'FromSignal', undefined, branch.path)
			)
		);
		assert.ok(branch.tables.FromSignal, 'the receiver reloaded the branch');
		assert.strictEqual(databases[BASE].FromSignal, undefined);
		assert.strictEqual(
			reloadBranchAt('/nowhere/such/branch'),
			undefined,
			'a thread without the branch has nothing to do'
		);
		assertNothingAnnouncedFrom(branch);
	});

	it('releases every store a declaration opened when the branch closes', async function () {
		const { branch, declare } = await branchedFactory();
		declare({
			table: 'Released',
			database: BASE,
			schemaDefined: true,
			attributes: [id, { name: 'tag', type: 'String', indexed: true }],
		});
		// a re-declaration with an index displaces the wrappers the first one opened; both generations are owned
		declare({
			table: 'Released',
			database: BASE,
			schemaDefined: true,
			attributes: [
				id,
				{ name: 'tag', type: 'String', indexed: true },
				{ name: 'other', type: 'String', indexed: true },
			],
		});
		const Released = branch.tables.Released;
		const held = [Released.primaryStore, Released.indices.tag, Released.indices.other, ...branch.openedStores];
		assert.ok(held.length > 4, 'sanity: the declarations opened stores');

		await closeBranchAt(branch.path);

		for (const store of held) {
			assert.strictEqual(store.status, 'closed', `a store the branch owned is still open: ${store.name ?? store.path}`);
		}
	});

	it('a second, unbranched application alongside sees the untouched base', async function () {
		const { scopedBindings } = require('#src/security/jsLoader');
		const { branch, declare } = await branchedFactory();
		declare({ table: 'Private', database: BASE, schemaDefined: true, attributes: [id] });

		const other = scopedBindings({});
		assert.strictEqual(other.databases, databases);
		assert.strictEqual(other.databases[BASE].Private, undefined);
		assert.ok(other.databases[BASE].Existing, 'the base table the branch started from is still the base one');
		assert.notStrictEqual(other.databases[BASE].Existing, branch.tables.Existing);
	});
});

describeUnlessLmdb('schema authoring paths from a branched scope (harper#2264)', () => {
	const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
	const { tmpdir } = require('node:os');
	const { basename } = require('node:path');
	const { stringify } = require('yaml');
	let Scope, ApplicationScope, Resources, handleApplication, scopedBindings, prepareBranches;
	const APP = 'authoringApp';
	const BASE = 'authorbase';
	let directory;
	let openScope;

	before(function () {
		({ Scope } = require('#src/components/Scope'));
		({ ApplicationScope } = require('#src/components/ApplicationScope'));
		({ Resources } = require('#src/resources/Resources'));
		({ handleApplication } = require('#src/resources/graphql'));
		({ scopedBindings } = require('#src/security/jsLoader'));
		({ prepareBranches } = require('#src/resources/branchDatabase'));
		setupTestDBPath();
		setMainIsWorker(true);
		table({ table: 'AuthorSource', database: BASE, attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async function () {
		try {
			await openScope?.close();
		} finally {
			openScope = undefined;
			if (directory) rmSync(directory, { recursive: true, force: true });
			directory = undefined;
			await removeBranches();
		}
	});

	async function branchedApplicationScope() {
		const applicationScope = new ApplicationScope(APP, new Resources(), {});
		applicationScope.branches = await prepareBranches(APP, [BASE], 'vm-current-context');
		return applicationScope;
	}

	it('lands a GraphQL @table declaration in the branch, exported route and imported binding alike', async function () {
		this.timeout(30000);
		const applicationScope = await branchedApplicationScope();
		const branch = applicationScope.branches.get(BASE);
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.branched-graphql-'));
		writeFileSync(
			join(directory, 'schema.graphql'),
			`type GqlDeclared @table(database: "${BASE}") @export {\n\tid: ID @primaryKey\n\tnote: String\n}\n`
		);
		const configFilePath = join(directory, 'config.yaml');
		writeFileSync(configFilePath, stringify({ graphqlSchema: { files: 'schema.graphql' } }));
		const scope = new Scope(basename(directory), 'graphqlSchema', directory, configFilePath, applicationScope);
		openScope = scope;
		await scope.ready;

		await handleApplication(scope);

		const Declared = branch.tables.GqlDeclared;
		assert.ok(Declared, 'the @table declaration created the table in the branch');
		assert.strictEqual(databases[BASE].GqlDeclared, undefined, 'and not in the base');
		const exported = [...applicationScope.resources.values()].find((entry) => entry.Resource === Declared);
		assert.ok(exported, 'the exported route is backed by the branch class');
		// what `import { databases } from 'harper'` resolves to inside the application
		assert.strictEqual(scopedBindings(applicationScope).databases[BASE].GqlDeclared, Declared);
		await Declared.put({ id: 'g', note: 'through the branch' });
		assert.strictEqual((await Declared.get('g'))?.note, 'through the branch');
	});

	it('lands scope.ensureTable in the branch', async function () {
		this.timeout(30000);
		const applicationScope = await branchedApplicationScope();
		const branch = applicationScope.branches.get(BASE);
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.branched-ensure-'));
		const configFilePath = join(directory, 'config.yaml');
		writeFileSync(configFilePath, stringify({ jsResource: { files: 'resources.js' } }));
		const scope = new Scope(basename(directory), 'jsResource', directory, configFilePath, applicationScope);
		openScope = scope;
		await scope.ready;

		const Ensured = scope.ensureTable({
			table: 'Ensured',
			database: BASE,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});

		assert.strictEqual(branch.tables.Ensured, Ensured);
		assert.strictEqual(databases[BASE].Ensured, undefined);
		assert.strictEqual(Ensured.origin, basename(directory), 'the origin stamp is unchanged');
	});

	it('leaves an unbranched scope on the global factory and the global objects', async function () {
		const applicationScope = new ApplicationScope('plain', new Resources(), {});
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.plain-ensure-'));
		const configFilePath = join(directory, 'config.yaml');
		writeFileSync(configFilePath, stringify({ jsResource: { files: 'resources.js' } }));
		const scope = new Scope(basename(directory), 'jsResource', directory, configFilePath, applicationScope);
		openScope = scope;
		await scope.ready;

		const definition = { table: 'PlainEnsured', database: BASE, attributes: [{ name: 'id', isPrimaryKey: true }] };
		const Ensured = scope.ensureTable(definition);

		assert.strictEqual(Ensured, databases[BASE].PlainEnsured);
		assert.strictEqual(Ensured, table(definition));
		assert.strictEqual(scopedBindings(applicationScope).databases, databases);
	});
});

describe('defineTable through a branched application (harper#643)', () => {
	let scopedBindings;

	before(function () {
		({ scopedBindings } = require('#src/security/jsLoader'));
		setupTestDBPath();
		setMainIsWorker(true);
		table({ table: 'DefSource', database: 'defbase', attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'OtherSource', database: 'otherbase', attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async function () {
		await removeBranches();
	});

	itUnlessLmdb('defines into the branch rather than into the base (harper#2264)', async function () {
		// Without this the table would appear in the base -- replicated and visible to every other
		// application -- while this application's own reads and writes went to its branch.
		const { types } = require('#src/resources/defineTable');
		const branch = await getOrCreateBranch('defbase', 'defApp');
		const { defineTable, databases: scoped } = scopedBindings({ branches: new Map([['defbase', branch]]) });
		const shape = { id: types.id.primaryKey, note: types.string.nullable };

		const Defined = defineTable('Defined', shape, { database: 'defbase' });

		assert.strictEqual(branch.tables.Defined, Defined, 'the returned handle is the branch class');
		assert.strictEqual(scoped.defbase.Defined, Defined, "and what the application's own `databases` resolves");
		assert.strictEqual(databases.defbase.Defined, undefined, 'nothing is created in the base');
		await Defined.put({ id: 'd', note: 'branch-defined' });
		assert.strictEqual((await Defined.get('d'))?.note, 'branch-defined');
		// re-declaring through defineTable evolves the branch table, the way a reload does
		const Evolved = defineTable('Defined', { ...shape, extra: types.string.nullable }, { database: 'defbase' });
		assert.strictEqual(Evolved, Defined);
		assert.ok(Evolved.attributes.some((attribute) => attribute.name === 'extra'));
	});

	itUnlessLmdb('still defines into databases the application did not branch', async function () {
		const branch = await getOrCreateBranch('defbase', 'defApp');
		const { defineTable } = scopedBindings({ branches: new Map([['defbase', branch]]) });

		defineTable('Unbranched', { id: 'string' }, { database: 'otherbase' });
		assert.ok(databases.otherbase.Unbranched, 'an unbranched database is untouched by the gate');
	});

	it('leaves defineTable itself alone for an unbranched application', function () {
		const { defineTable: real } = require('#src/resources/defineTable');
		assert.strictEqual(scopedBindings({}).defineTable, real, 'no wrapper for the common case');
	});
});

describeUnlessLmdb('relationships inside a branch (harper#643)', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'RelTarget',
			database: 'relbase',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'label' }],
		});
		const target = databases.relbase.RelTarget;
		table({
			table: 'RelHost',
			database: 'relbase',
			schemaDefined: true,
			schemaRelationshipsDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'targetId', type: 'ID', indexed: {} },
				{
					name: 'target',
					type: 'RelTarget',
					relationship: { from: 'targetId' },
					relationshipReference: { database: 'relbase', table: 'RelTarget' },
					definition: { tableClass: target },
				},
			],
		});
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('resolves a relationship against the branch, never against the base', async function () {
		this.timeout(30000);
		const { prepareBranches } = require('#src/resources/branchDatabase');
		const branch = (await prepareBranches('relApp', ['relbase'], 'vm-current-context')).get('relbase');

		const attribute = branch.tables.RelHost.attributes.find((a) => a.name === 'target');
		assert.ok(attribute, 'the branch table must carry the relationship attribute at all');

		// A branch's persisted relationship names the BASE database, because a branch's tables
		// deliberately carry the base's logical names. Resolving it through the global map would point
		// a branched application's relationship reads at the base's rows — isolation gone, silently.
		const targetClass = (attribute.definition || attribute.elements?.definition)?.tableClass;
		assert.strictEqual(targetClass, branch.tables.RelTarget, 'must resolve to the branch’s own target');
		assert.notStrictEqual(targetClass, databases.relbase.RelTarget, 'and never to the base’s');
	});
});

describeUnlessLmdb(
	"a branch's relationship never falls back to the base's own copy of a branched database (harper#643)",
	() => {
		before(function () {
			setupTestDBPath();
			setMainIsWorker(true);
			table({
				table: 'FallbackHost',
				database: 'fallbackbase',
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'lateId', type: 'ID', indexed: {} },
				],
			});
		});

		afterEach(async function () {
			await removeBranches();
		});

		it("resolves a relationship's target only within its own branch, never through the base", async function () {
			this.timeout(30000);
			const { prepareBranches } = require('#src/resources/branchDatabase');
			const { hydrateBranchRelationships } = require('#src/resources/databases');

			// A durable branch's own on-disk store can carry a persisted relationship whose target this
			// SPECIFIC branch never received -- the table was added to the base only after this branch's
			// checkpoint -- which is exactly what `hydrateBranchRelationships` is handed when a branch is
			// reopened later. Constructing that queued record directly (rather than relying on the
			// checkpoint-and-restart sequence that would normally produce it) is what makes this a unit test
			// rather than an integration one; the resolver under test is the same either way.
			const branches = await prepareBranches('fallbackApp', ['fallbackbase'], 'vm-current-context');
			const branch = branches.get('fallbackbase');

			// The base gains the target table -- the branch's own store never will.
			table({
				table: 'AfterCheckpoint',
				database: 'fallbackbase',
				attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
			});
			assert.strictEqual(branch.tables.AfterCheckpoint, undefined, "sanity: the branch really doesn't have it");

			branch.pendingRelationships.push({
				table: branch.tables.FallbackHost,
				databaseName: 'fallbackbase',
				tableName: 'FallbackHost',
				definitions: [
					{
						name: 'late',
						type: 'AfterCheckpoint',
						relationship: { from: 'lateId' },
						target: { database: 'fallbackbase', table: 'AfterCheckpoint' },
					},
				],
			});
			hydrateBranchRelationships(branch, branches);

			const attribute = branch.tables.FallbackHost.attributes.find((a) => a.name === 'late');
			const targetClass = attribute && (attribute.definition || attribute.elements?.definition)?.tableClass;
			assert.strictEqual(
				targetClass,
				undefined,
				"a target the branch's own store does not have must resolve to nothing, never to the base's"
			);
		});
	}
);

describeUnlessLmdb('blobs in a branch (harper#644)', () => {
	const { createBlob, getFilePathForBlob, getBlobPathsForDatabaseName } = require('#src/resources/blob');
	// Comfortably above any inline threshold, and compressible content would be fine too -- only the
	// size decides whether this lands in the blob tree.
	const PAYLOAD = Buffer.alloc(64 * 1024, 'base blob contents ');
	const BRANCH_STORE = `${'blobApp'.length}_blobApp__blobbase`;
	let BlobSource;

	function assertFileBacked(blob, what) {
		assert.ok(getFilePathForBlob(blob), `${what} must be a file-backed blob for this suite to test anything`);
	}

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		BlobSource = table({
			table: 'BlobSource',
			database: 'blobbase',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		// Written to the base BEFORE any branch exists, so a branch's checkpointed record references a
		// blob file the base already owns -- the case that is broken without the clone.
		await BlobSource.put({ id: 'from-base', payload: await createBlob(PAYLOAD) });
		assertFileBacked((await databases.blobbase.BlobSource.get('from-base')).payload, "the base's blob");
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('serves a blob the base wrote before the branch was taken', async function () {
		this.timeout(30000);
		const branch = await getOrCreateBranch('blobbase', 'blobApp');

		const record = await branch.tables.BlobSource.get('from-base');
		assert.ok(record, 'the branch has the row');
		assertFileBacked(record.payload, "the branch's view of the blob");
		// The branch resolves blob ids under its OWN root, so without the clone this file is not there.
		assert.ok(existsSync(getFilePathForBlob(record.payload)), 'the branch has its own copy of the file');
		assert.ok(PAYLOAD.equals(Buffer.from(await record.payload.bytes())), 'and it reads back byte-identical');
	});

	it("writes its own blobs into its own root, leaving the base's bytes alone", async function () {
		this.timeout(30000);
		const branch = await getOrCreateBranch('blobbase', 'blobApp');
		const replacement = Buffer.alloc(64 * 1024, 'branch wrote this ');

		await branch.tables.BlobSource.put({ id: 'from-base', payload: await createBlob(replacement) });
		const throughBranch = await branch.tables.BlobSource.get('from-base');
		assert.ok(replacement.equals(Buffer.from(await throughBranch.payload.bytes())));

		const base = await databases.blobbase.BlobSource.get('from-base');
		assert.ok(PAYLOAD.equals(Buffer.from(await base.payload.bytes())), "the base's blob is untouched");
	});

	it('removes its blob root when the branch is removed', async function () {
		this.timeout(30000);
		await getOrCreateBranch('blobbase', 'blobApp');
		const [branchBlobRoot] = getBlobPathsForDatabaseName(BRANCH_STORE);
		assert.ok(existsSync(branchBlobRoot), `expected a branch blob root at ${branchBlobRoot}`);

		await removeBranches();

		// The blob root lives outside the branch directory, so removing only the directory would strand
		// it -- and being hard links, the bytes would survive the base deleting its own copies.
		assert.strictEqual(existsSync(branchBlobRoot), false, 'the branch takes its blob root with it');
		assert.ok(existsSync(getBlobPathsForDatabaseName('blobbase')[0]), "the base's blob root stays");
	});
});

describeUnlessLmdb('branch blob-root safety (harper#644)', () => {
	const { chmodSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, cpSync } = require('node:fs');
	const { dirname, join } = require('node:path');
	const { getBlobPathsForDatabaseName, createBlob, getFilePathForBlob } = require('#src/resources/blob');
	const STORE = `${'safeApp'.length}_safeApp__safebase`;

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'Safe',
			database: 'safebase',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		await databases.safebase.Safe.put({ id: 'seed', payload: await createBlob(Buffer.alloc(64 * 1024, 'x')) });
	});

	afterEach(async function () {
		await removeBranches();
		// A refused branch never entered the handle cache, so `removeBranches` cannot reach it; left in
		// place it would fail every later test in this suite the same way.
		rmSync(resolveBranchPath('safebase', 'safeApp'), { recursive: true, force: true });
		for (const root of getBlobPathsForDatabaseName(STORE)) rmSync(root, { recursive: true, force: true });
	});

	it('refuses an identity a real database already answers to, before removing anything', async function () {
		this.timeout(30000);
		// A branch's blob root is `<blobs>/<identity>` and materialization REMOVES and replaces it, so a
		// database legally named like the identity would have its blob root deleted. schemaRegex permits
		// digits, `_` and `.`, so this name is reachable. Its own app name, because registering the
		// database claims that identity for the rest of the process.
		const clashStore = `${'clashApp'.length}_clashApp__safebase`;
		table({ table: 'Victim', database: clashStore, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const victimRoot = getBlobPathsForDatabaseName(clashStore)[0];
		mkdirSync(victimRoot, { recursive: true });
		writeFileSync(join(victimRoot, 'precious'), 'the victim database owns this');

		await assert.rejects(() => getOrCreateBranch('safebase', 'clashApp'), /already in use/);

		assert.ok(existsSync(join(victimRoot, 'precious')), "the real database's blob root must survive");
	});

	it('refuses to serve or rebuild a branch that lost a blob root, rather than silently re-forking', async function () {
		this.timeout(30000);
		await getOrCreateBranch('safebase', 'safeApp');
		const branchPath = resolveBranchPath('safebase', 'safeApp');

		// Keep a real, complete branch aside, tear the live one down so nothing is cached, then put back
		// the directory WITHOUT its blob roots. That is the state a power loss can leave, since the
		// directory and the roots live on different volumes and neither rename is fsynced.
		const saved = `${branchPath}.savedforTest`;
		cpSync(branchPath, saved, { recursive: true });
		await removeBranches();
		cpSync(saved, branchPath, { recursive: true });
		rmSync(saved, { recursive: true, force: true });
		assert.ok(
			getBlobPathsForDatabaseName(STORE).every((root) => !existsSync(root)),
			'sanity: directory present, blob roots gone'
		);

		// Rebuilding here would re-fork from the base and silently discard everything written to the
		// branch since it was created; a branch that was once complete may hold data that exists nowhere
		// else. Refusing leaves it intact and puts the decision in front of an operator.
		await assert.rejects(() => getOrCreateBranch('safebase', 'safeApp'), /cannot be trusted/);
		assert.ok(existsSync(branchPath), 'and it does not delete what it refused to serve');

		rmSync(branchPath, { recursive: true, force: true });
	});

	it('clears leftovers that are not a store and rebuilds, where there is nothing to lose', async function () {
		this.timeout(30000);
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		// No completion marker AND no CURRENT: not a database, so nothing was ever written here and
		// clearing it is safe. This is the only shape that may be deleted.
		mkdirSync(branchPath, { recursive: true });
		writeFileSync(join(branchPath, 'stray'), 'leftovers that are not a store');

		const branch = await getOrCreateBranch('safebase', 'safeApp');
		assert.ok(await branch.tables.Safe.get('seed'), 'rebuilt from the base');
		assert.ok(getBlobPathsForDatabaseName(STORE).every((root) => existsSync(root)));
	});

	it('refuses, never deletes, a real store that carries no completion marker', async function () {
		this.timeout(30000);
		// Exactly the shape every branch created before the marker existed has, and the shape a branch
		// whose marker was lost to operator cleanup or an unsynced write has. Materialization cannot
		// produce it -- it publishes by renaming a staging directory that already holds the marker -- so
		// anything marker-less that IS a store came from elsewhere and is carrying data.
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		mkdirSync(branchPath, { recursive: true });
		writeFileSync(join(branchPath, 'CURRENT'), 'MANIFEST-000001\n');

		await assert.rejects(() => getOrCreateBranch('safebase', 'safeApp'), /cannot be trusted/);
		assert.ok(existsSync(join(branchPath, 'CURRENT')), 'the store must still be there, not re-forked away');
	});

	it("substitutes a marker, in the branch's own words, for a base blob that was mid-write", async function () {
		this.timeout(30000);
		// Linking it would carry a truncated blob in, and the abort that follows stamps PENDING onto that
		// inode in place -- through the branch's link too, since it is the same inode.
		const [baseRoot] = getBlobPathsForDatabaseName('safebase');
		// An uncompressed header promising 100 bytes over a file holding 10.
		const header = Buffer.alloc(8);
		header.writeUInt16BE(0, 0);
		header.writeUIntBE(100, 2, 6);
		mkdirSync(join(baseRoot, '900/900'), { recursive: true });
		writeFileSync(join(baseRoot, '900/900/900'), Buffer.concat([header, Buffer.alloc(10, 'z')]));

		try {
			await getOrCreateBranch('safebase', 'safeApp');
			const substituted = readFileSync(join(getBlobPathsForDatabaseName(STORE)[0], '900/900/900'));
			assert.strictEqual(substituted.readUInt16BE(0), 0xfe, 'the branch gets a PENDING marker, not the torn bytes');
			assert.match(substituted.subarray(8).toString(), /still being written to the base when this branch was created/);
		} finally {
			rmSync(join(baseRoot, '900'), { recursive: true, force: true });
		}
	});

	it('clears a directory holding nothing but a malformed completion marker, and rebuilds', async function () {
		this.timeout(30000);
		// Refusing is only right where there is data to lose; a directory holding nothing but marker
		// garbage has none, so it must stay clearable rather than needing an operator.
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		mkdirSync(branchPath, { recursive: true });
		writeFileSync(join(branchPath, '.branch-complete'), JSON.stringify({ blobRoots: [] }));

		const branch = await getOrCreateBranch('safebase', 'safeApp');
		assert.ok(await branch.tables.Safe.get('seed'), 'rebuilt from the base');
	});

	it('refuses a completion marker that records no blob roots at all', async function () {
		this.timeout(30000);
		// An empty list is an exact prefix of anything, so without its own guard it reads as complete and
		// the first blob write fails on an undefined path instead of here.
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		mkdirSync(branchPath, { recursive: true });
		writeFileSync(join(branchPath, 'CURRENT'), 'MANIFEST-000001\n');
		writeFileSync(join(branchPath, '.branch-complete'), JSON.stringify({ blobRoots: [] }));

		await assert.rejects(() => getOrCreateBranch('safebase', 'safeApp'), /cannot be trusted/);
	});

	it('refuses a branch whose recorded blob roots no longer match the configuration', async function () {
		this.timeout(30000);
		await getOrCreateBranch('safebase', 'safeApp');
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		const saved = `${branchPath}.savedforTest`;
		cpSync(branchPath, saved, { recursive: true });
		await removeBranches();
		cpSync(saved, branchPath, { recursive: true });
		rmSync(saved, { recursive: true, force: true });

		// `storageIndex` on a row is a position in this list, so a reordered or resized blobPaths would
		// resolve rows through the wrong root. The marker records what was published, which is exactly
		// what makes that detectable.
		writeFileSync(join(branchPath, '.branch-complete'), JSON.stringify({ blobRoots: ['/nowhere/at/all'] }));

		await assert.rejects(() => getOrCreateBranch('safebase', 'safeApp'), /no longer match the configured/);
	});

	it('hard-links rather than copies, so the clone costs no extra bytes', async function () {
		this.timeout(30000);
		const branch = await getOrCreateBranch('safebase', 'safeApp');

		const baseFile = getFilePathForBlob((await databases.safebase.Safe.get('seed')).payload);
		const branchFile = getFilePathForBlob((await branch.tables.Safe.get('seed')).payload);
		assert.notStrictEqual(baseFile, branchFile, 'the branch resolves its own path');
		// The whole design rests on this: same inode, so the OS refcount IS the reference count. A silent
		// fallback to copyFile would double disk and make first load O(bytes) with nothing noticing.
		assert.strictEqual(statSync(branchFile).ino, statSync(baseFile).ino, 'same inode');
		assert.ok(statSync(branchFile).nlink >= 2, 'and more than one link to it');
	});

	it('refuses a database named after the identity the clone renames from', async function () {
		this.timeout(30000);
		await getOrCreateBranch('safebase', 'safeApp');

		// `cloneBlobRoots` populates `<root>.staging` and renames it over `<root>`, and a blob root is
		// `<blobs>/<database>`, so a database legally called `<identity>.staging` resolves its own root
		// to the very path materialization removes and replaces.
		assert.throws(
			() =>
				table({
					table: 'Sneak',
					database: `${STORE}.staging`,
					attributes: [{ name: 'id', isPrimaryKey: true }],
				}),
			/branch store identity/
		);
	});

	it('refuses a stranded identity to databases, while letting the branch itself take it back', async function () {
		this.timeout(30000);
		// Removal needs write permission on the containing directory, so a read-only volume is a real
		// filesystem refusal rather than a stubbed one.
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		await getOrCreateBranch('safebase', 'safeApp');
		const [root] = getBlobPathsForDatabaseName(STORE);
		const volume = dirname(root);

		chmodSync(volume, 0o500);
		try {
			// The removal fails rather than reporting success with the root still on disk, and keeps its
			// tombstone as the record of what is still owed.
			await assert.rejects(removeBranches(), /blob roots could not be deleted/);
			assert.ok(existsSync(root), 'sanity: the blob root outlived the branch directory');
			assert.throws(
				() => table({ table: 'Squatter', database: STORE, attributes: [{ name: 'id', isPrimaryKey: true }] }),
				/branch store identity/,
				'a database under that name would mint its own file ids onto the files left behind'
			);
		} finally {
			chmodSync(volume, 0o700);
		}

		// The next load finishes the interrupted removal (the roots can go now) and materializes afresh, so
		// the branch is the one holder that may take the name back; otherwise one transient EBUSY makes
		// the application unloadable for the process life.
		const rebuilt = await getOrCreateBranch('safebase', 'safeApp');
		assert.strictEqual(
			existsSync(`${resolveBranchPath('safebase', 'safeApp')}\`removing\``),
			false,
			'the interrupted removal was finished on the way'
		);
		assert.ok(await rebuilt.tables.Safe.get('seed'), 'the application loads again');
	});

	it('keeps the identity reserved until the blob roots are gone, not just the directory', async function () {
		this.timeout(30000);
		const branch = await getOrCreateBranch('safebase', 'safeApp');
		// Not a timing race: every step of a recursive `rm` is a separate libuv round trip, so the window
		// between the directory going and the last root going spans dozens of event-loop turns, and
		// `setImmediate` samples every one of them. The blobs are here to make it dozens rather than two.
		for (let i = 0; i < 12; i++) {
			await branch.tables.Safe.put({ id: `blob-${i}`, payload: await createBlob(Buffer.alloc(64 * 1024, `${i}`)) });
		}
		const branchPath = resolveBranchPath('safebase', 'safeApp');
		const [root] = getBlobPathsForDatabaseName(STORE);

		let sawTheWindow = false;
		const removal = removeBranches();
		for (;;) {
			const settled = await Promise.race([
				removal.then(() => true),
				new Promise((resolve) => setImmediate(() => resolve(false))),
			]);
			// Once the directory is gone the on-disk half of `isBranchIdentity` sees nothing either, so
			// the held reservation is all that stops a database claiming the name — and having its own
			// fresh blob files deleted by the removal still running.
			if (!existsSync(branchPath) && existsSync(root)) {
				sawTheWindow = true;
				assert.throws(
					() => table({ table: 'Racer', database: STORE, attributes: [{ name: 'id', isPrimaryKey: true }] }),
					/branch store identity/,
					'the identity must stay reserved for every turn of cleanup'
				);
			}
			if (settled) break;
		}
		await removal;
		assert.ok(sawTheWindow, 'sanity: the test must observe the window it guards');
	});
});

describeUnlessLmdb('branch identity is unavailable across restarts and restores (harper#644)', () => {
	const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
	const { join } = require('node:path');
	const { isBranchIdentity, resolveDatabasePath } = require('#src/resources/databases');

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({ table: 'Src', database: 'identbase', attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async function () {
		await removeBranches();
		rmSync(resolveBranchPath('identbase', 'identApp'), { recursive: true, force: true });
	});

	it('recognises a branch identity from the directory, not just from what this process has open', async function () {
		this.timeout(30000);
		const identity = `${'identApp'.length}_identApp__identbase`;
		assert.strictEqual(isBranchIdentity(identity), false, 'sanity: nothing owns it yet');

		await getOrCreateBranch('identbase', 'identApp');
		await removeBranches(); // drops the in-memory set, as a restart would
		mkdirSync(resolveBranchPath('identbase', 'identApp'), { recursive: true });

		// The in-memory set only knows branches open in THIS process. After a restart -- or for an app
		// that is simply not loaded -- a database could otherwise take this name and share the branch's
		// blob root, which is silent corruption in both directions.
		assert.strictEqual(isBranchIdentity(identity), true, 'the on-disk branch still owns its identity');
	});

	it('recognises the staging sibling of an on-disk branch identity too', async function () {
		this.timeout(30000);
		const identity = `${'identApp'.length}_identApp__identbase`;

		await getOrCreateBranch('identbase', 'identApp');
		await removeBranches(); // drops the in-memory set, as a restart would
		mkdirSync(resolveBranchPath('identbase', 'identApp'), { recursive: true });

		// A rebuild of this branch renames `<root>.staging` over `<root>`, so the sibling name has to be
		// unavailable across a restart for the same reason the identity itself is.
		assert.strictEqual(isBranchIdentity(`${identity}.staging`), true, 'the sibling is spoken for as well');
	});

	it("refuses either branch whose staging path is the other branch's live blob root", async function () {
		this.timeout(30000);
		// `<identity>.staging` is the path a clone removes and renames over, and it is also the legal
		// identity of a branch of a database named `<base>.staging`. Whichever of the two is created
		// second must be refused, or materializing it destroys the other's live blob root.
		const { assertBranchIdentityAvailable } = require('#src/resources/databases');
		const plain = `${'identApp'.length}_identApp__identbase`;
		for (const [existing, refused] of [
			['identbase.staging', plain],
			['identbase', `${plain}.staging`],
		]) {
			const planted = resolveBranchPath(existing, 'identApp');
			mkdirSync(planted, { recursive: true });
			try {
				assert.throws(
					() => assertBranchIdentityAvailable(refused),
					/already in use/,
					`a branch of '${existing}' already answers to what '${refused}' would take`
				);
			} finally {
				rmSync(planted, { recursive: true, force: true });
			}
		}
	});

	it('recognises a branch of a database whose own name ends in .staging', function () {
		// `schemaRegex` permits `.`, so this name has two readings: the staging sibling of a branch of
		// `stage`, and a branch of a database actually called `stage.staging`. Both own a blob path, so
		// stripping the suffix before parsing must not lose the second one.
		const identity = `${'identApp'.length}_identApp__stage.staging`;
		assert.strictEqual(isBranchIdentity(identity), false, 'sanity: nothing owns it yet');

		const planted = resolveBranchPath('stage.staging', 'identApp');
		mkdirSync(planted, { recursive: true });
		try {
			assert.strictEqual(isBranchIdentity(identity), true, 'the branch of `stage.staging` owns its identity');
		} finally {
			rmSync(planted, { recursive: true, force: true });
		}
	});

	it('refuses create_database under a live branch identity, not only schema authoring', async function () {
		this.timeout(30000);
		// `create_database` reaches `database()` through its own bridge, so the guard on the `table()`
		// authoring path never sees it: the database would share the branch's blob root, and dropping it
		// deletes the branch's blobs.
		const { createSchemaStructure } = require('#src/dataLayer/schema');
		const identity = `${'identApp'.length}_identApp__identbase`;
		await getOrCreateBranch('identbase', 'identApp');

		await assert.rejects(
			() => createSchemaStructure({ schema: identity }),
			/in use as a branch store identity/,
			'create_database must refuse the name for the same reason schema authoring does'
		);
	});

	it('refuses an identity whose database exists on disk but is not loaded', async function () {
		this.timeout(30000);
		const { assertBranchIdentityAvailable } = require('#src/resources/databases');
		const identity = `${'blockedApp'.length}_blockedApp__identbase`;

		// `getDatabases()` skips a database blocked by restore, so it is absent from every in-memory
		// map while its blob root is real -- and materialization would remove and replace that root.
		// A directory standing in for exactly that: present on disk, absent from the maps.
		const planted = resolveDatabasePath(identity);
		mkdirSync(planted, { recursive: true });
		writeFileSync(join(planted, 'CURRENT'), 'a database this process has not loaded\n');
		try {
			assert.throws(() => assertBranchIdentityAvailable(identity), /already in use/);
		} finally {
			rmSync(planted, { recursive: true, force: true });
		}
	});
});

describeUnlessLmdb('blob-volume configuration changes (harper#644)', () => {
	const { mkdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } = require('node:fs');
	const { tmpdir } = require('node:os');
	const { join } = require('node:path');
	const { getBlobPathsForDatabaseName, createBlob, getFilePathForBlob } = require('#src/resources/blob');
	const environment = require('#src/utility/environment/environmentManager');
	const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
	const { prepareBranches } = require('#src/resources/branchDatabase');
	const STORE = `${'volApp'.length}_volApp__volbase`;
	const PAYLOAD = Buffer.alloc(64 * 1024, 'volume payload ');
	let firstVolume, secondVolume, configuredBefore;

	/** Where a run of new branch blobs actually landed. Blobs are spread across the configured roots by
	 *  free space, so a pinned branch has to be proven over several writes rather than one. */
	async function writeBlobs(branch, prefix) {
		const paths = [];
		for (let i = 0; i < 8; i++) {
			const id = `${prefix}-${i}`;
			await branch.tables.Vol.put({ id, payload: await createBlob(Buffer.alloc(64 * 1024, id)) });
			const path = getFilePathForBlob((await branch.tables.Vol.get(id)).payload);
			assert.ok(path, `sanity: ${id} must be file-backed`);
			paths.push(path);
		}
		return paths;
	}

	/**
	 * Give up this process's handle on a branch without touching its storage, the way a restart does.
	 * `removeBranches` is the only exported release and it deletes, so what is on disk is set aside
	 * and put back around it.
	 */
	async function reloadFromDisk(branch, branchPath, blobRoots) {
		const backupRoot = mkdtempSync(join(tmpdir(), 'harper.branch-reload-'));
		const aside = [branchPath, ...blobRoots].map((path, index) => [path, join(backupRoot, String(index))]);
		try {
			await branch.rootStore.createCheckpoint(aside[0][1]);
			cpSync(join(branchPath, '.branch-complete'), join(aside[0][1], '.branch-complete'));
			for (const [live, saved] of aside.slice(1)) cpSync(live, saved, { recursive: true });
			await removeBranches();
			for (const [live, saved] of aside) cpSync(saved, live, { recursive: true });
		} finally {
			rmSync(backupRoot, { recursive: true, force: true });
		}
	}

	before(async function () {
		this.timeout(30000);
		const dbPath = setupTestDBPath();
		setMainIsWorker(true);
		configuredBefore = environment.get(CONFIG_PARAMS.STORAGE_BLOBPATHS);
		firstVolume = join(dbPath, 'blob-volume-1');
		secondVolume = join(dbPath, 'blob-volume-2');
		for (const volume of [firstVolume, secondVolume]) mkdirSync(volume, { recursive: true });
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
		for (const db of ['volbase', 'volbase2']) {
			table({
				table: 'Vol',
				database: db,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'payload', type: 'Blob' },
				],
			});
		}
		await databases.volbase.Vol.put({ id: 'seed', payload: await createBlob(PAYLOAD) });

		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		table({
			table: 'Vol',
			database: 'volbaseShrink',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		await databases.volbaseShrink.Vol.put({ id: 'seed', payload: await createBlob(PAYLOAD) });
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
	});

	beforeEach(function () {
		// One volume to begin with, so appending the second is the operator action under test.
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
	});

	afterEach(async function () {
		await removeBranches();
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
		for (const appName of ['volApp']) {
			for (const baseName of ['volbase', 'volbase2', 'volbaseShrink']) {
				rmSync(resolveBranchPath(baseName, appName), { recursive: true, force: true });
				for (const volume of [firstVolume, secondVolume]) {
					rmSync(join(volume, `${appName.length}_${appName}__${baseName}`), { recursive: true, force: true });
				}
			}
		}
	});

	after(function () {
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, configuredBefore);
	});

	it('stays loadable when a volume is appended, and keeps resolving through the roots it recorded', async function () {
		this.timeout(30000);
		const created = await getOrCreateBranch('volbase', 'volApp');
		assert.ok(await created.tables.Vol.get('seed'), 'sanity: the branch carries the base row');
		const branchPath = resolveBranchPath('volbase', 'volApp');
		const recorded = getBlobPathsForDatabaseName(STORE);
		await reloadFromDisk(created, branchPath, recorded);

		// Every recorded root keeps its index, so every `storageIndex` a row already holds still means
		// what it meant. Refusing the branch here would take an application offline for a configuration
		// change that cannot have invalidated a single reference.
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		const reopened = await getOrCreateBranch('volbase', 'volApp');
		const seeded = await reopened.tables.Vol.get('seed');
		assert.ok(PAYLOAD.equals(Buffer.from(await seeded.payload.bytes())), 'and it still reads its blobs');

		// Pinned, not merely tolerated: a write into the appended volume would sit at an index the
		// completion marker never recorded, so a later change at that index would silently re-address it.
		// Several of them, because unpinned writes are spread over the volumes by free space, so one
		// landing in the recorded root proves nothing.
		for (const written of await writeBlobs(reopened, 'after')) {
			assert.ok(written.startsWith(recorded[0]), `expected ${written} under the recorded root ${recorded[0]}`);
		}
		assert.strictEqual(existsSync(join(secondVolume, STORE)), false, 'the appended volume is not this branch’s');
	});

	it('pins a branch adopted on the waiter path, not only one this thread published', async function () {
		this.timeout(30000);
		const recorded = getBlobPathsForDatabaseName(STORE);

		// A failed application load closes every handle it opened but leaves a successfully-published
		// branch's claim READY. The next call has no cached handle and must take the waiter/adopter path.
		const failing = resolveBranchPath('volbase2', 'volApp');
		mkdirSync(failing, { recursive: true });
		writeFileSync(join(failing, 'CURRENT'), 'not a database');
		publishHandBuiltBranch(failing, 'volApp', 'volbase2');
		await assert.rejects(() => prepareBranches('volApp', ['volbase', 'volbase2'], undefined));
		rmSync(failing, { recursive: true, force: true });

		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		const adopted = await getOrCreateBranch('volbase', 'volApp');
		for (const written of await writeBlobs(adopted, 'waiter')) {
			assert.ok(written.startsWith(recorded[0]), `expected ${written} under the recorded root ${recorded[0]}`);
		}
	});

	it('removes only the roots it recorded, leaving a like-named directory on a volume it never used', async function () {
		this.timeout(30000);
		await getOrCreateBranch('volbase', 'volApp');
		const [recordedRoot] = getBlobPathsForDatabaseName(STORE);

		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		// A directory that happens to carry this identity's name on the appended volume — restored from
		// a backup, copied from another node — was never part of this branch and is not its to delete.
		const stranger = join(secondVolume, STORE);
		mkdirSync(stranger, { recursive: true });
		writeFileSync(join(stranger, 'precious'), 'this branch never wrote here');

		await removeBranches();

		assert.strictEqual(existsSync(recordedRoot), false, 'the recorded root goes with the branch');
		assert.ok(existsSync(join(stranger, 'precious')), 'the unrecorded one is left alone');
	});

	it('deletes what the open handle is pinned to, not what a reordered configuration now says', async function () {
		this.timeout(30000);
		await getOrCreateBranch('volbase', 'volApp');
		const [recordedRoot] = getBlobPathsForDatabaseName(STORE);

		// Reordering is refused at adoption, but a branch already open goes on serving through what it
		// published — so its teardown has to delete that, not whatever the configuration now names.
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [secondVolume, firstVolume]);
		const stranger = join(secondVolume, STORE);
		mkdirSync(stranger, { recursive: true });
		writeFileSync(join(stranger, 'precious'), 'this branch never wrote here');

		await removeBranches();

		assert.strictEqual(existsSync(recordedRoot), false, 'the recorded root goes with the branch');
		assert.ok(existsSync(join(stranger, 'precious')), 'the reordered configuration is not what it owns');
	});

	it('refuses to publish a branch when no blob volume is configured at all', async function () {
		this.timeout(30000);
		// The marker it would otherwise write records no roots, which no later load can accept: the branch
		// would be bricked on every boot after this one.
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, []);

		await assert.rejects(() => getOrCreateBranch('volbase', 'volApp'), /nowhere of its own to keep blobs/);
	});

	it('refuses to publish a branch after the open base loses a configured blob volume', async function () {
		this.timeout(30000);
		const branchPath = resolveBranchPath('volbaseShrink', 'volApp');

		await assert.rejects(
			() => getOrCreateBranch('volbaseShrink', 'volApp'),
			/open base resolves through 2 blob root\(s\), but storage\.blobPaths now provides 1/
		);
		assert.strictEqual(existsSync(branchPath), false, 'an incomplete branch must not be published');
	});

	it('still refuses a branch whose recorded roots were dropped from the configuration', async function () {
		this.timeout(30000);
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		const created = await getOrCreateBranch('volbase', 'volApp');
		const branchPath = resolveBranchPath('volbase', 'volApp');
		await reloadFromDisk(created, branchPath, getBlobPathsForDatabaseName(STORE));

		// Growth is compatible because it moves no index; shrinking removes root 1 outright, and every
		// row whose `storageIndex` is 1 would resolve through nothing.
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
		await assert.rejects(() => getOrCreateBranch('volbase', 'volApp'), /no longer match the configured/);
	});

	it('still refuses a branch whose recorded roots were reordered', async function () {
		this.timeout(30000);
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume, secondVolume]);
		const created = await getOrCreateBranch('volbase', 'volApp');
		const branchPath = resolveBranchPath('volbase', 'volApp');
		await reloadFromDisk(created, branchPath, getBlobPathsForDatabaseName(STORE));

		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [secondVolume, firstVolume]);
		await assert.rejects(() => getOrCreateBranch('volbase', 'volApp'), /no longer match the configured/);
	});
});

describe('the claim budget follows the winner (harper#644)', () => {
	// Driven directly: within one isolate `branchesByPath` dedupes callers, so nothing in-process ever
	// takes the waiting side of this protocol.
	const { claimDeadlineFor, reportClaimProgress } = require('#src/resources/branchDatabase');

	it('restarts the budget when the winner reports progress, and runs it down when it does not', async function () {
		const claimState = new BigInt64Array(2);
		const deadline = claimDeadlineFor(claimState, 1000);
		const first = deadline();

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(deadline(), first, 'a winner that has reported nothing still expires on schedule');

		reportClaimProgress(claimState);
		assert.ok(deadline() > first, 'a unit of work finished buys the waiters another full budget');
	});
});

describeUnlessLmdb('the undeploy sequence (harper#644)', () => {
	const { rmSync, mkdirSync, existsSync: exists } = require('node:fs');
	const { getBlobPathsForDatabaseName, createBlob } = require('#src/resources/blob');
	const { removeBranchesForApplication } = require('#src/resources/branchDatabase');
	const { database } = require('#src/resources/databases');
	const STORE = `${'cycleApp'.length}_cycleApp__cyclebase`;

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'Cycle',
			database: 'cyclebase',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		await databases.cyclebase.Cycle.put({ id: 'seed', payload: await createBlob(Buffer.alloc(64 * 1024, 'z')) });
	});

	afterEach(async function () {
		await removeBranches().catch(() => {});
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		rmSync(branchPath, { recursive: true, force: true });
		rmSync(`${branchPath}\`removing\``, { recursive: true, force: true });
		for (const root of getBlobPathsForDatabaseName(STORE)) rmSync(root, { recursive: true, force: true });
	});

	it('refuses to remove a branch while a reference it does not own is still held', async function () {
		this.timeout(30000);
		const { openBranchDatabase } = require('#src/resources/databases');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		await branch.tables.Cycle.put({ id: 'held', kept: true });
		branch.close();
		// A holder this thread's cache knows nothing about, standing in for another thread's handle.
		const foreign = openBranchDatabase(branchPath, 'cyclebase', STORE);
		try {
			await assert.rejects(removeBranchesForApplication('cycleApp'), /open reference\(s\) to its store remain/);
			assert.ok(exists(branchPath), 'the checkpoint is untouched');
			assert.ok(
				getBlobPathsForDatabaseName(STORE).some((root) => exists(root)),
				'and so are its blob roots'
			);
		} finally {
			foreign.close();
		}
		const reopened = await getOrCreateBranch('cyclebase', 'cycleApp');
		assert.ok(await reopened.tables.Cycle.get('held'), 'the refused branch is still fully usable');
	});

	it('closes its own handle, then removes the branch, its blob roots and its claim', async function () {
		this.timeout(30000);
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const claimWord = () =>
			new BigInt64Array(
				database({ database: 'cyclebase', table: undefined }).getUserSharedBuffer(
					`branch-claim:${branchPath}`,
					new BigInt64Array([0n]).buffer
				)
			);
		await getOrCreateBranch('cyclebase', 'cycleApp');
		// Not closed here: the removing thread loaded the application too, and its own handle is the one
		// reference that is not evidence of a live reader.
		Atomics.store(claimWord(), 0, 2n); // READY, as the worker that created it left it

		await removeBranchesForApplication('cycleApp');

		assert.strictEqual(exists(branchPath), false, 'the checkpoint is gone');
		assert.ok(
			getBlobPathsForDatabaseName(STORE).every((root) => !exists(root)),
			'so are its blob roots'
		);
		assert.strictEqual(Atomics.load(claimWord(), 0), 0n, 'and the claim is released');
		assert.ok(exists(getBlobPathsForDatabaseName('cyclebase')[0]), "the base's blob root is untouched");

		const redeployed = await getOrCreateBranch('cyclebase', 'cycleApp');
		assert.ok(await redeployed.tables.Cycle.get('seed'), 'a redeploy materializes cleanly');
	});

	it('publishes its intent before unlinking anything, so a removal cut short is finished, not lost', async function () {
		this.timeout(30000);
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip(); // root ignores the permission that stands in for the crash
		const { chmodSync, writeFileSync } = require('node:fs');
		const { join } = require('node:path');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		// Standing in for a crash part-way through: an entry the final delete cannot unlink. Removal must
		// already have moved the directory to its tombstone by then -- deleting in place would leave a
		// half-gone branch that reads as damaged, with no record of what was being removed.
		const hold = join(branchPath, 'hold');
		mkdirSync(hold);
		writeFileSync(join(hold, 'keep'), '');
		chmodSync(hold, 0o555);
		try {
			await assert.rejects(removeBranchesForApplication('cycleApp'), /Could not remove branch storage/);
			assert.strictEqual(exists(branchPath), false, 'the branch directory was renamed away, not deleted in place');
			assert.ok(exists(removing), 'and the tombstone says which removal was interrupted');
		} finally {
			for (const dir of [join(removing, 'hold'), hold]) if (exists(dir)) chmodSync(dir, 0o755);
		}

		const redeployed = await getOrCreateBranch('cyclebase', 'cycleApp');
		assert.strictEqual(exists(removing), false, 'the next load finished the removal');
		assert.ok(await redeployed.tables.Cycle.get('seed'), 'and then materialized afresh');
	});

	it('finishes an interrupted removal rather than refusing the branch forever', async function () {
		this.timeout(30000);
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		await getOrCreateBranch('cyclebase', 'cycleApp');
		await removeBranches();

		// The state a crash between the rename and the delete leaves. Only the removal path can produce
		// this name, so it is unambiguous -- which is the point: without it, a half-removed branch reads
		// as damaged and is refused forever, needing an operator with a shell.
		mkdirSync(`${branchPath}\`removing\``, { recursive: true });

		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		assert.ok(await branch.tables.Cycle.get('seed'), 'the branch materializes rather than refusing');
		assert.strictEqual(exists(`${branchPath}\`removing\``), false, 'and the interrupted removal is finished');
	});

	it('removes a branch this thread never opened, and hands back only a READY claim', async function () {
		this.timeout(30000);
		const { rename: mv, mkdir: mkd } = require('node:fs/promises');
		const { join } = require('node:path');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const claimWord = () =>
			new BigInt64Array(
				database({ database: 'cyclebase', table: undefined }).getUserSharedBuffer(
					`branch-claim:${branchPath}`,
					new BigInt64Array([0n]).buffer
				)
			);
		// Published by a previous boot, as the main thread sees a branch of an application it never loaded.
		const staging = `${branchPath}.staging`;
		await mkd(join(branchPath, '..'), { recursive: true });
		await database({ database: 'cyclebase', table: undefined }).createCheckpoint(staging);
		await mv(staging, branchPath);
		publishHandBuiltBranch(branchPath, 'cycleApp', 'cyclebase');
		for (const root of getBlobPathsForDatabaseName(STORE)) mkdirSync(root, { recursive: true });

		// A loader that won the claim since must not be turned back into a waiter's opening.
		Atomics.store(claimWord(), 0, 1n); // CREATING
		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(exists(branchPath), false);
		assert.strictEqual(Atomics.load(claimWord(), 0), 1n, 'a CREATING claim is left to its owner');

		Atomics.store(claimWord(), 0, 2n); // READY, as the worker that created it left it
		await mkd(join(branchPath, '..'), { recursive: true });
		await database({ database: 'cyclebase', table: undefined }).createCheckpoint(staging);
		await mv(staging, branchPath);
		publishHandBuiltBranch(branchPath, 'cycleApp', 'cyclebase');
		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(exists(branchPath), false, 'the never-opened branch is gone');
		assert.ok(
			getBlobPathsForDatabaseName(STORE).every((root) => !exists(root)),
			'and its roots with it'
		);
		assert.strictEqual(Atomics.load(claimWord(), 0), 0n, 'a READY claim is handed back');
	});

	it('knows whether an application has branch storage to lose, tombstones included', async function () {
		this.timeout(30000);
		const { renameSync } = require('node:fs');
		const { applicationHasBranchStorage } = require('#src/resources/branchDatabase');
		assert.strictEqual(applicationHasBranchStorage('neverBranched'), false);
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		assert.strictEqual(applicationHasBranchStorage('cycleApp'), true);
		branch.close();
		renameSync(branchPath, `${branchPath}\`removing\``);
		assert.strictEqual(applicationHasBranchStorage('cycleApp'), true, 'a tombstone still owes storage');
		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(applicationHasBranchStorage('cycleApp'), false);
	});

	it('deletes no blob roots for a tombstone that lost its marker', async function () {
		this.timeout(30000);
		const { renameSync, rmSync: rmS, writeFileSync } = require('node:fs');
		const { join } = require('node:path');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		renameSync(branchPath, removing);
		// The final delete removed the marker and then died, leaving a marker-less tombstone. A same-named
		// directory on a configured volume, from a restore say, is not this branch's to delete.
		rmS(join(removing, '.branch-complete'));
		const [root] = getBlobPathsForDatabaseName(STORE);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'not-ours'), '');

		await removeBranchesForApplication('cycleApp');

		assert.strictEqual(exists(removing), false, 'the tombstone itself is cleared');
		assert.ok(exists(join(root, 'not-ours')), 'but nothing outside it was touched');
		rmS(root, { recursive: true, force: true });
	});

	it('finishes a removal tombstone during the undeploy walk instead of skipping it', async function () {
		this.timeout(30000);
		const { renameSync } = require('node:fs');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		// A crash after the tombstone rename and before the blob roots went.
		renameSync(branchPath, removing);
		assert.ok(
			getBlobPathsForDatabaseName(STORE).some((root) => exists(root)),
			'roots still present'
		);

		await removeBranchesForApplication('cycleApp');

		assert.strictEqual(exists(removing), false, 'the tombstone was finished');
		assert.ok(
			getBlobPathsForDatabaseName(STORE).every((root) => !exists(root)),
			'and its blob roots went with it'
		);
	});

	it('keeps the store identity guarded while only the tombstone is on disk', async function () {
		this.timeout(30000);
		const { renameSync } = require('node:fs');
		const { table, isBranchIdentity } = require('#src/resources/databases');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		renameSync(branchPath, removing);
		// The blob roots the tombstone points at are still this branch's, so a database under the same
		// name would mint its own file ids onto them.
		assert.ok(isBranchIdentity(STORE), 'a tombstone is still a branch on disk');
		assert.throws(
			() => table({ table: 'Squatter', database: STORE, attributes: [{ name: 'id', isPrimaryKey: true }] }),
			/branch store identity/
		);
		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(exists(removing), false);
	});

	it('will not finish a tombstone whose identity a database has since taken', async function () {
		this.timeout(30000);
		const { renameSync, rmSync: rmS } = require('node:fs');
		const { resolveDatabasePath } = require('#src/resources/databases');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		renameSync(branchPath, removing);
		// A database directory under the identity's name (created outside this process's guard, say by a
		// restore) owns the blob root the tombstone still points at.
		const squatter = resolveDatabasePath(STORE);
		mkdirSync(squatter, { recursive: true });
		try {
			await assert.rejects(removeBranchesForApplication('cycleApp'), /already in use/);
			assert.ok(exists(removing), 'the tombstone is kept');
			assert.ok(
				getBlobPathsForDatabaseName(STORE).some((root) => exists(root)),
				"and the root, now the database's, is untouched"
			);
		} finally {
			rmS(squatter, { recursive: true, force: true });
		}
		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(exists(removing), false, 'finished once the name is free again');
	});

	it('keeps the tombstone and fails when a blob root cannot be removed', async function () {
		this.timeout(30000);
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		const { chmodSync, writeFileSync } = require('node:fs');
		const { join } = require('node:path');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const removing = `${branchPath}\`removing\``;
		await getOrCreateBranch('cyclebase', 'cycleApp');
		const [root] = getBlobPathsForDatabaseName(STORE);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'stuck'), '');
		chmodSync(root, 0o555);
		try {
			await assert.rejects(removeBranchesForApplication('cycleApp'), /blob roots could not be deleted/);
			assert.strictEqual(exists(branchPath), false, 'the checkpoint directory was renamed away');
			assert.ok(exists(removing), 'and the tombstone records what is still owed');
		} finally {
			chmodSync(root, 0o755);
		}

		await removeBranchesForApplication('cycleApp');
		assert.strictEqual(exists(removing), false, 'a retry finishes it');
		assert.strictEqual(exists(root), false);
	});

	it('reports an application directory it cannot read instead of treating it as empty', async function () {
		this.timeout(30000);
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		const { chmodSync } = require('node:fs');
		const { dirname } = require('node:path');
		const branchPath = resolveBranchPath('cyclebase', 'cycleApp');
		const branch = await getOrCreateBranch('cyclebase', 'cycleApp');
		branch.close();
		const appDirectory = dirname(branchPath);
		chmodSync(appDirectory, 0o000);
		try {
			await assert.rejects(removeBranchesForApplication('cycleApp'), /EACCES/);
		} finally {
			chmodSync(appDirectory, 0o755);
		}
		assert.ok(exists(branchPath), 'nothing was removed');
		await removeBranchesForApplication('cycleApp');
	});
});

describeUnlessLmdb('branch control paths cannot be spelled as a database name (harper#644)', () => {
	const { rmSync } = require('node:fs');
	const { getBlobPathsForDatabaseName } = require('#src/resources/blob');

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// Both are legal database names -- `schemaRegex` permits `.` -- and one is the other plus what
		// used to be the removal suffix.
		for (const db of ['collide', 'collide.removing']) {
			table({ table: 'Row', database: db, attributes: [{ name: 'id', isPrimaryKey: true }] });
		}
	});

	afterEach(async function () {
		await removeBranches().catch(() => {});
		for (const db of ['collide', 'collide.removing']) {
			rmSync(resolveBranchPath(db, 'collideApp'), { recursive: true, force: true });
			for (const root of getBlobPathsForDatabaseName(`${'collideApp'.length}_collideApp__${db}`)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it('opens a branch of `x` without destroying the branch of `x.removing`', async function () {
		this.timeout(30000);
		const other = await getOrCreateBranch('collide.removing', 'collideApp');
		await other.tables.Row.put({ id: 'belongs-to-the-other-branch' });

		// Deriving a control path by suffixing a user-chosen name made the ordinary load path destructive:
		// opening the branch of `collide` saw `<app>/collide.removing` -- a healthy branch of a different
		// database -- read it as an interrupted removal, and deleted it along with its blob roots.
		await getOrCreateBranch('collide', 'collideApp');

		assert.ok(existsSync(resolveBranchPath('collide.removing', 'collideApp')), 'the other branch survives');
		assert.ok(await other.tables.Row.get('belongs-to-the-other-branch'), 'with its rows intact');
		assert.ok(
			getBlobPathsForDatabaseName(`${'collideApp'.length}_collideApp__collide.removing`).every((root) =>
				existsSync(root)
			),
			'and its blob roots were not deleted either'
		);
	});
});

describeUnlessLmdb('a table declared into a branch on one thread reaches another thread (harper#2264)', () => {
	const { Worker } = require('node:worker_threads');
	const { scopedTableFactory } = require('#src/resources/databases');
	const { prepareBranches } = require('#src/resources/branchDatabase');
	const APP = 'threadApp';
	const BASE = 'threadbase';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({ table: 'ThreadSource', database: BASE, attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('is loaded by the reload the schema-change signal triggers, not by re-declaring', async function () {
		this.timeout(60000);
		const branches = await prepareBranches(APP, [BASE], 'vm-current-context');
		const branch = branches.get(BASE);
		const phase = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(__dirname + '/branchDeclare-thread.js', {
			workerData: { phase, baseName: BASE, appName: APP, tableName: 'Threaded', addPorts: [] },
		});
		try {
			const failure = new Promise((_, reject) => worker.once('error', reject));
			const message = (type) =>
				Promise.race([
					failure,
					new Promise((resolve) => {
						worker.on('message', function onMessage(received) {
							if (received.type !== type) return;
							worker.off('message', onMessage);
							resolve(received);
						});
					}),
				]);
			const opened = message('opened');
			const reloaded = message('reloaded');
			assert.strictEqual(
				(await opened).loaded,
				false,
				'sanity: the other thread opened the branch before the table existed'
			);

			const Threaded = scopedTableFactory(branches)({
				table: 'Threaded',
				database: BASE,
				schemaDefined: true,
				attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'note' }],
			});
			await Threaded.put({ id: 'declared-elsewhere', note: 'seen across threads' });
			Atomics.store(phase, 0, 1);
			Atomics.notify(phase, 0);

			const seen = await reloaded;
			assert.strictEqual(seen.loaded, true, 'the other thread has the class after its reload');
			assert.deepStrictEqual(seen.attributes, ['id', 'note']);
			assert.strictEqual(seen.note, 'seen across threads', 'and reads the row through it');
			assert.strictEqual(databases[BASE].Threaded, undefined, 'the base has nothing on either thread');
			assert.ok(branch.tables.Threaded);
		} finally {
			await worker.terminate();
		}
	});
});
