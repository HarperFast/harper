require('../testUtils');
const assert = require('assert');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, BRANCH_ROOT_DIR, resolveBranchPath } = require('#src/resources/databases');
const { getOrCreateBranch, removeBranches, sweepStaleBranches } = require('#src/resources/branchDatabase');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('branch lifecycle (harper#643)', () => {
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
		const branch = await getOrCreateBranch('lifebase', 'appA', 'inst1');

		const row = await branch.tables.LifecycleSource.get('a');
		assert.strictEqual(row?.note, 'base');
		const expected = resolveBranchPath('lifebase', 'appA', 'inst1');
		assert.ok(existsSync(expected), `expected the branch at ${expected}`);
		assert.ok(expected.includes(BRANCH_ROOT_DIR), 'branches belong under the reserved root');
	});

	it('gives concurrent callers the same branch rather than racing two checkpoints', async function () {
		// Every worker thread loads the same applications, so this is the ordinary case, not an edge one.
		const [first, second, third] = await Promise.all([
			getOrCreateBranch('lifebase', 'appA', 'inst1'),
			getOrCreateBranch('lifebase', 'appA', 'inst1'),
			getOrCreateBranch('lifebase', 'appA', 'inst1'),
		]);
		assert.strictEqual(first, second);
		assert.strictEqual(second, third);
	});

	it('keeps two applications on separate branches', async function () {
		const a = await getOrCreateBranch('lifebase', 'appA', 'inst1');
		const b = await getOrCreateBranch('lifebase', 'appB', 'inst1');

		await a.tables.LifecycleSource.put({ id: 'only-a', note: 'from A' });

		assert.ok(await a.tables.LifecycleSource.get('only-a'));
		assert.ok(
			!(await b.tables.LifecycleSource.get('only-a')),
			"one application's writes must not be visible to another's branch"
		);
		assert.ok(!(await databases.lifebase.LifecycleSource.get('only-a')), 'nor to the base');
	});

	it('leaves the base untouched and unaware', async function () {
		const branch = await getOrCreateBranch('lifebase', 'appA', 'inst1');
		await branch.tables.LifecycleSource.put({ id: 'a', note: 'changed in branch' });

		const base = await databases.lifebase.LifecycleSource.get('a');
		assert.strictEqual(base.note, 'base', 'a branch write must not reach the base');
	});

	it('removes its directories on teardown', async function () {
		await getOrCreateBranch('lifebase', 'appA', 'inst1');
		const path = resolveBranchPath('lifebase', 'appA', 'inst1');
		assert.ok(existsSync(path));

		await removeBranches();
		assert.strictEqual(existsSync(path), false, 'a branch does not outlive the process');
	});

	it('sweeps only its own instance directory and reports the rest', async function () {
		await getOrCreateBranch('lifebase', 'appA', 'other-instance');
		const otherPath = resolveBranchPath('lifebase', 'appA', 'other-instance');
		assert.ok(existsSync(otherPath));
		// Drop the in-process handles so the sweep is acting on directories alone, the way a fresh
		// process would see them.
		await removeBranches();
		await getOrCreateBranch('lifebase', 'appA', 'other-instance');

		const retained = await sweepStaleBranches('lifebase', 'inst-not-used');

		assert.deepStrictEqual(
			retained,
			['other-instance'],
			"a UUID proves identity, not liveness, so another instance's directory is reported not deleted"
		);
		assert.ok(existsSync(otherPath), 'and left in place');
	});

	it('refuses DDL through a branch, leaving the base schema intact', async function () {
		const branch = await getOrCreateBranch('lifebase', 'appA', 'inst1');
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
		assert.throws(() => resolveBranchPath('lifebase', '..', 'inst1'), /Invalid application name/);
		assert.throws(() => resolveBranchPath('lifebase', 'appA', 'a/b'), /Invalid instance name/);
	});
});

describe('branchedDatabases config (harper#643)', () => {
	const { assertBranchedDatabases } = require('#src/components/Application');

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
	const { prepareBranches } = require('#src/resources/branchDatabase');

	before(function () {
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

	it('refuses a database that does not exist rather than creating one', async function () {
		await assert.rejects(() => prepareBranches('app', ['no-such-db'], 'vm-current-context'), /does not exist/);
	});

	it('branches a real database and exposes it under its logical name', async function () {
		const branches = await prepareBranches('app', ['prepbase'], 'vm-current-context');
		assert.ok(branches.get('prepbase')?.tables.PrepSource);
	});
});

describe('scoped databases binding (harper#643)', () => {
	const { scopedBindings } = require('#src/security/jsLoader');
	const { tables } = require('#src/resources/databases');

	before(function () {
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

	it('resolves a branched name to the branch and leaves the rest alone', async function () {
		const branch = await getOrCreateBranch('bindbase', 'bindApp', 'inst1');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });

		assert.strictEqual(bindings.databases.bindbase, branch.tables);
		assert.notStrictEqual(bindings.databases.bindbase, databases.bindbase);
		// An unbranched name still resolves to the real database, by identity.
		assert.strictEqual(bindings.databases.lifebase, databases.lifebase);
		// And the global map is untouched.
		assert.notStrictEqual(databases.bindbase, branch.tables);
	});

	it('keeps `databases.system` reachable and non-enumerable', async function () {
		// It is defined non-enumerable on the real map, so building the view by copying enumerable
		// properties would drop it and a branched application would lose the system database entirely.
		const branch = await getOrCreateBranch('bindbase', 'bindApp', 'inst1');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });

		assert.ok(bindings.databases.system, 'system must still be reachable');
		assert.strictEqual(
			Object.propertyIsEnumerable.call(bindings.databases, 'system'),
			false,
			'and must stay non-enumerable'
		);
	});

	it('keeps showing databases created after the application loaded', async function () {
		// `databases` gains entries at runtime, which is exactly what ensureTable/@table do. A view
		// snapshotted at load would leave a branched application unable to see them.
		const branch = await getOrCreateBranch('bindbase', 'bindApp', 'inst1');
		const bindings = scopedBindings({ branches: new Map([['bindbase', branch]]) });
		assert.strictEqual(bindings.databases.bindlater, undefined);

		table({ table: 'Later', database: 'bindlater', attributes: [{ name: 'id', isPrimaryKey: true }] });

		assert.ok(bindings.databases.bindlater?.Later, 'a database created after load must be visible');
		assert.strictEqual(bindings.databases.bindbase, branch.tables, 'and the branch still wins for its own name');
	});
});

describe('branch rollback is scoped to the failing application (harper#643)', () => {
	const { mkdirSync, writeFileSync } = require('node:fs');
	const { COMPONENT_PREPARATION_PROCESS_INSTANCE_ID } = require('#src/components/componentPreparationLock');
	const { prepareBranches } = require('#src/resources/branchDatabase');

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		for (const db of ['rollbase1', 'rollbase2']) {
			table({ table: 'Roll', database: db, attributes: [{ name: 'id', isPrimaryKey: true }] });
		}
	});

	afterEach(async function () {
		await removeBranches();
	});

	it("leaves an already-loaded application's branch open when a later application fails", async function () {
		this.timeout(30000);
		const survivor = await getOrCreateBranch('rollbase1', 'loadedFirst');
		await survivor.tables.Roll.put({ id: 'kept', note: 'x' });

		// Applications load one after another. Make the second declared database of a *later*
		// application fail to materialize: an occupied branch path makes the rename into place fail,
		// which is the same shape as a checkpoint that cannot complete.
		const blocked = resolveBranchPath('rollbase2', 'loadedSecond', COMPONENT_PREPARATION_PROCESS_INSTANCE_ID);
		mkdirSync(blocked, { recursive: true });
		writeFileSync(join(blocked, 'occupied'), 'x');

		await assert.rejects(() => prepareBranches('loadedSecond', ['rollbase1', 'rollbase2'], undefined));

		assert.ok(
			await survivor.tables.Roll.get('kept'),
			"a failed application's rollback must not close a loaded application's branch"
		);
		assert.strictEqual(
			existsSync(resolveBranchPath('rollbase1', 'loadedSecond', COMPONENT_PREPARATION_PROCESS_INSTANCE_ID)),
			false,
			'while the failing application keeps none of its own'
		);
	});
});

describe('defineTable through a branched application (harper#643)', () => {
	const { scopedBindings } = require('#src/security/jsLoader');

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({ table: 'DefSource', database: 'defbase', attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'OtherSource', database: 'otherbase', attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async function () {
		await removeBranches();
	});

	it('refuses to define into a branched database rather than defining into the base', async function () {
		// defineTable registers in the process-wide catalog, so without this the table would appear in
		// the base -- replicated and visible to every other application -- while this application's
		// own reads and writes went to its branch. Landing it in the branch is harper#2264.
		const branch = await getOrCreateBranch('defbase', 'defApp', 'inst1');
		const { defineTable } = scopedBindings({ branches: new Map([['defbase', branch]]) });

		assert.throws(() => defineTable('Defined', { id: 'string' }, { database: 'defbase' }), /branched database/);
		assert.strictEqual(databases.defbase.Defined, undefined, 'and nothing must be created in the base');
	});

	it('still defines into databases the application did not branch', async function () {
		const branch = await getOrCreateBranch('defbase', 'defApp', 'inst1');
		const { defineTable } = scopedBindings({ branches: new Map([['defbase', branch]]) });

		defineTable('Unbranched', { id: 'string' }, { database: 'otherbase' });
		assert.ok(databases.otherbase.Unbranched, 'an unbranched database is untouched by the gate');
	});

	it('leaves defineTable itself alone for an unbranched application', function () {
		const { defineTable: real } = require('#src/resources/defineTable');
		assert.strictEqual(scopedBindings({}).defineTable, real, 'no wrapper for the common case');
	});
});
