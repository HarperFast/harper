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
					return [{ type: 'put', tableId: 7, version: 1, extendedType: 17, getValue: () => ({ id: 1 }) }];
				},
			},
		};
		await assert.rejects(() => replayLogs(stubStore, { Poisoned: poisonedTable }, true), /poisoned resource/);
		assert.strictEqual(unlocked, true, 'a failed strict replay must release the lock for the retry');
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
	const { dirname } = require('node:path');
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
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, 'not a database');
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

describe('declaring a table from a branched application (harper#643)', () => {
	const { assertTableTargetNotBranched } = require('#src/resources/branchGuard');

	it('refuses every declaration path that would land in the base', function () {
		// GraphQL @table, scope.ensureTable and defineTable all funnel into the process-wide table(),
		// so gating only one of them leaves the base reachable through the other two -- and @table is
		// the path most applications actually use.
		const branches = new Map([['gatedbase', {}]]);
		for (const how of ['a GraphQL @table directive', 'ensureTable', 'defineTable']) {
			assert.throws(() => assertTableTargetNotBranched(branches, 'gatedbase', 'T', how), /branched database/);
		}
	});

	it('defaults every falsy database name the way table() does', function () {
		// `table()` resolves any falsy name to the default database (`if (!databaseName)`), so a guard
		// that only defaulted nullish names would let `database: ''` past the fence and then land in
		// the base as `data`.
		for (const falsy of ['', null, undefined]) {
			assert.throws(
				() => assertTableTargetNotBranched(new Map([['data', {}]]), falsy, 'T', 'defineTable'),
				/branched database 'data'/,
				`${JSON.stringify(falsy)} must resolve to the default database`
			);
		}
	});

	it('defaults an unnamed database to the default one', function () {
		// `@table` and defineTable both omit `database` to mean `data`, so a branch of `data` has to
		// catch the omitted case or the most common declaration of all slips through.
		assert.throws(
			() => assertTableTargetNotBranched(new Map([['data', {}]]), undefined, 'T', 'defineTable'),
			/branched database 'data'/
		);
	});

	it('leaves unbranched targets and unbranched applications alone', function () {
		assert.doesNotThrow(() => assertTableTargetNotBranched(new Map([['gatedbase', {}]]), 'other', 'T', 'defineTable'));
		assert.doesNotThrow(() => assertTableTargetNotBranched(undefined, 'gatedbase', 'T', 'defineTable'));
		assert.doesNotThrow(() => assertTableTargetNotBranched(new Map(), 'gatedbase', 'T', 'defineTable'));
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

	itUnlessLmdb('refuses to define into a branched database rather than defining into the base', async function () {
		// defineTable registers in the process-wide catalog, so without this the table would appear in
		// the base -- replicated and visible to every other application -- while this application's
		// own reads and writes went to its branch. Landing it in the branch is harper#2264.
		const branch = await getOrCreateBranch('defbase', 'defApp');
		const { defineTable } = scopedBindings({ branches: new Map([['defbase', branch]]) });

		assert.throws(() => defineTable('Defined', { id: 'string' }, { database: 'defbase' }), /branched database/);
		assert.strictEqual(databases.defbase.Defined, undefined, 'and nothing must be created in the base');
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
