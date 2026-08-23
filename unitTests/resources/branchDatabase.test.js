require('../testUtils');
const assert = require('assert');
const { existsSync } = require('node:fs');
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
