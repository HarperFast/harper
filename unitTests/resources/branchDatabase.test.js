require('../testUtils');
const assert = require('assert');
const { existsSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, BRANCH_ROOT_DIR, resolveBranchPath } = require('#src/resources/databases');
const { getOrCreateBranch, removeBranches } = require('#src/resources/branchDatabase');
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
