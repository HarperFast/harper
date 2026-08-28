'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const { Readable } = require('node:stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	activateCandidateApplication,
	prepareApplication,
	recoverInterruptedActivations,
	recoverInterruptedComponentExtraction,
	unsettleableComponentsFromDisk,
	candidateApplicationPath,
	DEPLOY_STAGING_DIR,
	ASIDE_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const { withComponentPreparationLock } = require('#src/components/componentPreparationLock');

const IN_PROGRESS = '.in-progress-';

async function newRoot(label) {
	return fs.mkdtemp(path.join(os.tmpdir(), `activation-${label}-`));
}

async function writeTree(dirPath, marker) {
	await fs.mkdir(dirPath, { recursive: true });
	await fs.writeFile(path.join(dirPath, 'index.js'), marker);
	return dirPath;
}

/** Build the on-disk state a crash at a given boundary would leave, without running a deploy. */
async function stageState(root, component, id, state) {
	const deploymentDir = path.join(root, DEPLOY_STAGING_DIR, id);
	await fs.mkdir(deploymentDir, { recursive: true });
	if (state.candidate) await writeTree(path.join(deploymentDir, component), state.candidate);
	if (state.complete) await fs.writeFile(path.join(deploymentDir, '.complete'), '');
	if (state.componentFile !== false) await fs.writeFile(path.join(deploymentDir, 'component'), component);
	if (state.journal !== undefined) {
		await fs.writeFile(
			path.join(deploymentDir, 'activation.json'),
			typeof state.journal === 'string' ? state.journal : JSON.stringify({ v: 1, component, candidateId: id })
		);
	}
	if (state.live) await writeTree(path.join(root, component), state.live);
	if (state.aside || state.priorAbsent) {
		const asideDir = path.join(root, ASIDE_STAGING_DIR, component);
		await fs.mkdir(asideDir, { recursive: true });
		const asidePath = path.join(asideDir, `${IN_PROGRESS}1-1-aaa${state.priorAbsent ? '-prior-absent' : ''}`);
		if (state.priorAbsent) await fs.writeFile(asidePath, '');
		else await writeTree(asidePath, state.aside);
	}
	return { deploymentDir };
}

async function readLive(root, component) {
	return fs.readFile(path.join(root, component, 'index.js'), 'utf8');
}

describe('interrupted activation recovery', () => {
	it('rolls forward when the live path is gone and the candidate is complete', async () => {
		const root = await newRoot('forward');
		await stageState(root, 'web', 'd1', {
			candidate: 'CANDIDATE\n',
			complete: true,
			journal: true,
			aside: 'PREVIOUS\n',
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n', 'the validated candidate becomes live');
		assert.strictEqual(
			existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')),
			false,
			'the displaced tree is swept, not just marked disposable'
		);
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false, 'staging is cleaned up');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rolls BACK when the live path is gone and the candidate never completed', async () => {
		const root = await newRoot('incomplete');
		await stageState(root, 'web', 'd1', {
			candidate: 'HALF-BUILT\n',
			complete: false,
			journal: true,
			aside: 'PREVIOUS\n',
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'PREVIOUS\n', 'an unvalidated candidate never goes live');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rolls back from the aside when the candidate is gone entirely', async () => {
		const root = await newRoot('lostcand');
		await stageState(root, 'web', 'd1', { journal: true, aside: 'PREVIOUS\n' });

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'PREVIOUS\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('fails the component closed when neither a live tree nor a rollback record survives', async () => {
		const root = await newRoot('bothgone');
		await stageState(root, 'web', 'd1', { journal: true });

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 1, 'the component is reported, not silently skipped');
		assert.match(failures.get('web').message, /neither a live tree/);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('discards a candidate that never activated, leaving the live tree', async () => {
		const root = await newRoot('preb1');
		await stageState(root, 'web', 'd1', { live: 'LIVE\n', candidate: 'CANDIDATE\n', complete: true, journal: true });

		await recoverInterruptedActivations(root);

		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('finishes the tail when the candidate is already live', async () => {
		const root = await newRoot('postb2');
		await stageState(root, 'web', 'd1', { live: 'CANDIDATE\n', journal: true, aside: 'PREVIOUS\n' });

		await recoverInterruptedActivations(root);

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n', 'a completed activation is not reverted');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('treats a candidate with no journal as build residue', async () => {
		const root = await newRoot('nojournal');
		await stageState(root, 'web', 'd1', { live: 'LIVE\n', candidate: 'ABANDONED\n' });

		await recoverInterruptedActivations(root);

		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('fails closed on a truncated journal rather than guessing a direction', async () => {
		const root = await newRoot('truncated');
		await stageState(root, 'web', 'd1', {
			live: 'LIVE\n',
			candidate: 'CANDIDATE\n',
			journal: '{"v":1,"component":"web","candi',
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 1);
		assert.match(failures.get('web').message, /could not be parsed/);
		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n', 'nothing is touched');
		assert.ok(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), 'and the evidence is kept for an operator');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('fails closed on a journal written by a version it does not understand', async () => {
		const root = await newRoot('version');
		await stageState(root, 'web', 'd1', {
			live: 'LIVE\n',
			candidate: 'CANDIDATE\n',
			journal: JSON.stringify({ v: 99, component: 'web', candidateId: 'd1' }),
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 1);
		assert.match(failures.get('web').message, /version 99, expected 1/);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('attributes an unreadable journal to its component even after the candidate has moved', async () => {
		// The post-swap shape: the candidate is now the live tree, so nothing under the deployment directory
		// names the component. Without the sidecar the failure keys on the deployment id, which fails NOTHING
		// closed and lets the component load over state nobody reconciled.
		const root = await newRoot('attribution');
		await stageState(root, 'web', 'd1', { live: 'CANDIDATE\n', journal: 'truncated{' });

		const failures = await recoverInterruptedActivations(root);

		assert.deepStrictEqual([...failures.keys()], ['web'], 'keyed by component, not by deployment id');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('falls back to the deployment id when even the component sidecar is gone', async () => {
		const root = await newRoot('nosidecar');
		await stageState(root, 'web', 'd1', { live: 'CANDIDATE\n', journal: 'truncated{', componentFile: false });

		const failures = await recoverInterruptedActivations(root);

		assert.deepStrictEqual([...failures.keys()], ['d1'], 'nothing left to attribute it to, and it still reports');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('ignores a sidecar naming something outside the components root', async () => {
		const root = await newRoot('badsidecar');
		const { deploymentDir } = await stageState(root, 'web', 'd1', { live: 'CANDIDATE\n', journal: 'truncated{' });
		await fs.writeFile(path.join(deploymentDir, 'component'), '../../etc');

		const failures = await recoverInterruptedActivations(root);

		assert.deepStrictEqual([...failures.keys()], ['d1'], 'a traversal in the sidecar is refused, not joined');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses a journal whose component name could escape the components root', async () => {
		const root = await newRoot('traversal');
		await stageState(root, 'web', 'd1', {
			live: 'LIVE\n',
			candidate: 'X\n',
			journal: JSON.stringify({ v: 1, component: '../../victim', candidateId: 'd1' }),
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 1, 'reported, not acted on');
		assert.ok(!failures.has('../../victim'), 'and never keyed by the traversal it claimed');
		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses a journal that names a different deployment than the one holding it', async () => {
		const root = await newRoot('mismatch');
		await stageState(root, 'web', 'd1', {
			live: 'LIVE\n',
			candidate: 'X\n',
			journal: JSON.stringify({ v: 1, component: 'web', candidateId: 'someone-else' }),
		});

		const failures = await recoverInterruptedActivations(root);

		assert.strictEqual(failures.size, 1);
		assert.match(failures.get('web').message, /not its own deployment/);
		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('settles a healthy component even when a sibling journal is unreadable', async () => {
		const root = await newRoot('isolation');
		await stageState(root, 'broken', 'd1', { live: 'LIVE\n', candidate: 'X\n', journal: 'not json at all' });
		await stageState(root, 'healthy', 'd2', {
			candidate: 'CANDIDATE\n',
			complete: true,
			journal: true,
			aside: 'PREVIOUS\n',
		});

		const failures = await recoverInterruptedActivations(root);

		assert.deepStrictEqual([...failures.keys()], ['broken'], 'only the affected component is reported');
		assert.strictEqual(await readLive(root, 'healthy'), 'CANDIDATE\n', 'the healthy sibling still settles');
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('read-only verdict for worker boot', () => {
	it('reports a component whose journal cannot be read', async () => {
		const root = await newRoot('verdict');
		await stageState(root, 'web', 'd1', { live: 'LIVE\n', candidate: 'X\n', journal: 'not json' });

		const unsettleable = await unsettleableComponentsFromDisk(root);

		assert.deepStrictEqual([...unsettleable.keys()], ['web'], 'a worker can fail it closed without main');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('keeps the journal and fails closed when a rollback record cannot be retired', async () => {
		// Retiring is CORRECTNESS: the retired marker is what stops the journal-blind legacy pass treating the
		// record as authoritative. A record left un-retired while the journal is removed would let that pass
		// restore the displaced tree over the candidate just rolled forward — so this must fail closed and
		// keep the journal, not report success.
		const root = await newRoot('retirefail');
		const { deploymentDir } = await stageState(root, 'web', 'd1', {
			candidate: 'CANDIDATE\n',
			complete: true,
			journal: true,
			aside: 'PREVIOUS\n',
		});
		const asideDir = path.join(root, ASIDE_STAGING_DIR, 'web');
		await fs.chmod(asideDir, 0o500);

		let failures;
		try {
			failures = await recoverInterruptedActivations(root);
		} finally {
			await fs.chmod(asideDir, 0o700);
		}

		assert.strictEqual(failures.size, 1, 'the component is failed closed rather than reported settled');
		assert.ok(
			existsSync(path.join(deploymentDir, 'activation.json')),
			'and the journal survives, so the next start retries instead of letting the legacy pass win'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('reports a well-formed journal that main recovery could not settle', async () => {
		// The case a worker cannot infer: the journal parses fine, so it is indistinguishable from a deploy in
		// flight. Main records the failure so every thread reaches the same verdict.
		const root = await newRoot('recorded');
		const { deploymentDir } = await stageState(root, 'web', 'd1', { journal: true });

		const failures = await recoverInterruptedActivations(root);
		assert.strictEqual(failures.size, 1, 'main could not settle it (neither tree survives)');

		const unsettleable = await unsettleableComponentsFromDisk(root);
		assert.deepStrictEqual([...unsettleable.keys()], ['web'], 'and a worker sees it too');
		assert.ok(
			(await fs.readFile(path.join(deploymentDir, 'unsettled'), 'utf8')).length > 0,
			'the reason is recorded, not just the fact'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('stays silent for a healthy in-flight deploy', async () => {
		// Every deploy has a well-formed journal in flight. Treating that as evidence would fail a component
		// closed in the middle of its own successful deploy.
		const root = await newRoot('inflight');
		await stageState(root, 'web', 'd1', { live: 'LIVE\n', candidate: 'CANDIDATE\n', complete: true, journal: true });

		const unsettleable = await unsettleableComponentsFromDisk(root);

		assert.strictEqual(unsettleable.size, 0);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('stays silent when nothing is staged at all', async () => {
		const root = await newRoot('nostaging');
		assert.strictEqual((await unsettleableComponentsFromDisk(root)).size, 0);
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('journal-first on the deploy path', () => {
	it("is not blocked by another component's corrupt journal", async () => {
		// The pre-deploy settle must check ownership before parsing: parsing first turns one broken component
		// into a deploy outage for its neighbours. Exercised through the deploy path specifically — the
		// sibling-isolation test above covers only the startup pass.
		const root = await newRoot('siblingblock');
		await stageState(root, 'broken', 'd-broken', { live: 'BROKEN LIVE\n', candidate: 'X\n', journal: 'truncated{' });
		await writeTree(path.join(root, 'healthy'), 'HEALTHY v1\n');

		const app = new Application({
			name: 'healthy',
			payload: Readable.from(
				(async function* () {
					yield Buffer.from('not a tarball');
					throw new Error('payload delivery failed');
				})()
			),
		});
		app.dirPath = path.join(root, 'healthy');

		// The deploy still fails on its own payload — but with ITS error, not the sibling's journal parse.
		await assert.rejects(() => prepareApplication(app), /payload delivery failed/);
		assert.strictEqual(
			await readLive(root, 'healthy'),
			'HEALTHY v1\n',
			"and the healthy component is untouched by the neighbour's corrupt journal"
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('does not let the legacy aside pass restore a displaced tree over a live candidate', async () => {
		// The state a completed activation whose RETIREMENT failed leaves behind: the candidate is live, the
		// journal is still there, and an `.in-progress-*` aside still names the version it displaced. The
		// legacy pass is journal-blind and would restore that aside — putting the old version back.
		const root = await newRoot('journalfirst');
		await stageState(root, 'web', 'd1', { live: 'CANDIDATE\n', journal: true, aside: 'PREVIOUS\n' });
		// A payload that fails mid-delivery, so the deploy cannot succeed and replace the live tree — what is
		// under test is the state the settle leaves BEFORE the build runs. (An empty buffer would extract to
		// an empty tree and deploy successfully, which is why this uses a throwing stream.)
		const app = new Application({
			name: 'web',
			payload: Readable.from(
				(async function* () {
					yield Buffer.from('not a tarball');
					throw new Error('payload delivery failed');
				})()
			),
		});
		app.dirPath = path.join(root, 'web');

		await assert.rejects(() => prepareApplication(app));

		assert.strictEqual(
			await readLive(root, 'web'),
			'CANDIDATE\n',
			'the completed activation is settled first, so the displaced version is not restored over it'
		);
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('activation transaction', () => {
	it('swaps the candidate in and clears its own records', async () => {
		const root = await newRoot('happy');
		await writeTree(path.join(root, 'web'), 'LIVE\n');
		await writeTree(candidateApplicationPath(path.join(root, 'web'), 'd1'), 'CANDIDATE\n');
		const app = new Application({ name: 'web' });
		app.dirPath = path.join(root, 'web');

		await activateCandidateApplication(app, 'd1');

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n');
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false, 'staging is cleaned up');
		assert.strictEqual(
			existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')),
			false,
			'and the version it displaced is swept rather than accumulating per deploy'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('re-points a dependency link that named the candidate build path', async () => {
		// npm links a `file:` dependency into node_modules. POSIX gets a relative symlink that survives the
		// rename; Windows gets an ABSOLUTE junction, which after the swap still names the staging path and
		// leaves the dependency unresolvable. Simulated here with an absolute link, which is the shape that
		// breaks regardless of platform.
		const root = await newRoot('links');
		const live = path.join(root, 'web');
		await writeTree(live, 'LIVE\n');
		const candidate = candidateApplicationPath(live, 'd1');
		await writeTree(candidate, 'CANDIDATE\n');
		const vendored = path.join(candidate, 'vendor', 'probe');
		await fs.mkdir(vendored, { recursive: true });
		await fs.writeFile(path.join(vendored, 'index.js'), 'module.exports = 1;\n');
		await fs.mkdir(path.join(candidate, 'node_modules'), { recursive: true });
		await fs.symlink(vendored, path.join(candidate, 'node_modules', 'probe'), 'dir');

		const app = new Application({ name: 'web' });
		app.dirPath = live;
		await activateCandidateApplication(app, 'd1');

		const linkPath = path.join(live, 'node_modules', 'probe');
		const target = await fs.readlink(linkPath);
		assert.strictEqual(
			target,
			path.join(live, 'vendor', 'probe'),
			'the link follows the tree to its live path instead of naming the deleted candidate'
		);
		assert.strictEqual(
			await fs.readFile(path.join(linkPath, 'index.js'), 'utf8'),
			'module.exports = 1;\n',
			'and it resolves'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('leaves a sibling-prefixed link alone when re-pointing dependency links', async () => {
		// `startsWith` would classify `<build>-shared` as inside `<build>` and rewrite it to an unrelated
		// live path. Containment has to be a path check, not a string prefix.
		const root = await newRoot('prefix');
		const live = path.join(root, 'web');
		await writeTree(live, 'LIVE\n');
		const candidate = candidateApplicationPath(live, 'd1');
		await writeTree(candidate, 'CANDIDATE\n');
		// A real directory that merely SHARES a prefix with the candidate path.
		const sibling = `${candidate}-shared`;
		await fs.mkdir(sibling, { recursive: true });
		await fs.writeFile(path.join(sibling, 'index.js'), 'module.exports = 2;\n');
		await fs.mkdir(path.join(candidate, 'node_modules'), { recursive: true });
		await fs.symlink(sibling, path.join(candidate, 'node_modules', 'shared'), 'dir');

		const app = new Application({ name: 'web' });
		app.dirPath = live;
		await activateCandidateApplication(app, 'd1');

		assert.strictEqual(
			await fs.readlink(path.join(live, 'node_modules', 'shared')),
			sibling,
			'a link that only shares a prefix is untouched'
		);
		// Deliberately not asserting that it resolves: the prefix-sharing directory has to live beside the
		// candidate to share its prefix at all, so staging cleanup removes it. The property under test is
		// that the link was not REWRITTEN, which readlink above establishes.
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses to activate when there is no candidate build', async () => {
		const root = await newRoot('nocand');
		await writeTree(path.join(root, 'web'), 'LIVE\n');
		const app = new Application({ name: 'web' });
		app.dirPath = path.join(root, 'web');

		await assert.rejects(() => activateCandidateApplication(app, 'missing'), /no candidate build/);
		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('activates a first-ever deploy, where there is no previous tree to move aside', async () => {
		const root = await newRoot('firstever');
		await writeTree(candidateApplicationPath(path.join(root, 'web'), 'd1'), 'CANDIDATE\n');
		const app = new Application({ name: 'web' });
		app.dirPath = path.join(root, 'web');

		await activateCandidateApplication(app, 'd1');

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n');
		assert.strictEqual(app.isNewComponent, true, 'and it is recognized as a new component');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses to restore a rollback record while an activation journal is unsettled', async () => {
		const root = await newRoot('legacy-guard');
		// The state a completed activation leaves when retiring its rollback record failed: the candidate is
		// already live, and the tree it displaced is still an un-retired `.in-progress-` record. The legacy
		// pass reads that record as authoritative and would put the old version back over the new one.
		await stageState(root, 'web', 'd1', { live: 'new', aside: 'old', complete: true, journal: true });

		await assert.rejects(() => recoverInterruptedComponentExtraction(root, 'web', false), /is not settled/);

		assert.strictEqual(await readLive(root, 'web'), 'new', 'the committed candidate is still live');
	});

	it('fails one unreadable deployment closed without aborting the rest of the scan', async () => {
		const root = await newRoot('scan-isolation');
		// Ownership cannot be read at all: the sidecar is a directory, so the read fails with EISDIR rather
		// than reporting "unowned". This used to escape the scan and leave every later deployment unsettled.
		await fs.mkdir(path.join(root, DEPLOY_STAGING_DIR, 'd1', 'component'), { recursive: true });
		await stageState(root, 'web', 'd2', { candidate: 'new', complete: true, journal: true });

		const failures = await recoverInterruptedActivations(root);

		assert.ok(failures.has('d1'), 'the deployment that could not be read is reported');
		assert.strictEqual(await readLive(root, 'web'), 'new', 'its sibling was still settled');
	});

	it('keeps both trees when the live path reappears after the swap moved it aside', async () => {
		const root = await newRoot('live-recreated');
		// A rollback record says the live tree was already moved aside, yet the live path exists again — a
		// previous-version worker recreating its own directory. Neither tree present is known to be current,
		// and rolling back would delete the committed one AND the validated candidate.
		await stageState(root, 'web', 'd1', {
			candidate: 'new',
			complete: true,
			journal: true,
			aside: 'old',
			live: 'stub',
		});

		const failures = await recoverInterruptedActivations(root);

		assert.match(failures.get('web').message, /exists again/);
		assert.strictEqual(await readLive(root, 'web'), 'stub', 'nothing was overwritten');
		assert.strictEqual(
			await fs.readFile(path.join(root, ASIDE_STAGING_DIR, 'web', `${IN_PROGRESS}1-1-aaa`, 'index.js'), 'utf8'),
			'old',
			'the committed tree survives in its rollback record'
		);
		assert.ok(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1', 'web')), 'and so does the validated candidate');
	});

	it('still recovers a component whose rollback record was already retired', async () => {
		const root = await newRoot('retired-journal');
		// Roll-forward retired the record but could not flush the directory, so it keeps the journal on
		// purpose. There is nothing left to restore, so refusing here would strand a component whose live
		// tree is already the correctly activated candidate.
		await stageState(root, 'web', 'd1', { live: 'new', aside: 'old', complete: true, journal: true });
		await fs.writeFile(path.join(root, ASIDE_STAGING_DIR, 'web', '.retired-1-1-aaa'), '');

		await recoverInterruptedComponentExtraction(root, 'web', false);

		assert.strictEqual(await readLive(root, 'web'), 'new', 'the committed candidate still serves');
	});

	it('gives up on a component lock a live deploy is holding instead of queueing behind it', async function () {
		this.timeout(10000);
		const root = await newRoot('recovery-lock');
		await stageState(root, 'web', 'd1', { candidate: 'new', complete: true, journal: true });

		let failures;
		// The scan runs before every component load on every thread. Waiting here — the lock's default is a
		// two-hour wait that RENEWS while the holder lives — would park a respawning worker behind this
		// deploy's install and load no components at all until it finished.
		await withComponentPreparationLock(
			path.join(root, 'web'),
			async () => {
				failures = await recoverInterruptedActivations(root);
			},
			{ purpose: 'test-deploy' }
		);

		assert.ok(failures.get('web'), 'the component is reported as deferred');
		assert.ok(!existsSync(path.join(root, 'web')), 'and nothing was activated behind the deploy holding the lock');
	});
});
