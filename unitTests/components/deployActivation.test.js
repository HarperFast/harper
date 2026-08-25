'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	activateCandidateApplication,
	recoverInterruptedActivations,
	candidateApplicationPath,
	DEPLOY_STAGING_DIR,
	ASIDE_STAGING_DIR,
	Application,
} = require('#src/components/Application');

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
	if (state.journal !== undefined) {
		await fs.writeFile(
			path.join(deploymentDir, 'activation.json'),
			typeof state.journal === 'string'
				? state.journal
				: JSON.stringify({
						v: 1,
						component,
						candidateId: id,
						configBefore: state.configBefore ?? null,
						configAfter: state.configAfter ?? null,
					})
		);
	}
	if (state.live) await writeTree(path.join(root, component), state.live);
	let asidePath;
	if (state.aside || state.priorAbsent) {
		const asideDir = path.join(root, ASIDE_STAGING_DIR, component);
		await fs.mkdir(asideDir, { recursive: true });
		asidePath = path.join(asideDir, `${IN_PROGRESS}1-1-aaa${state.priorAbsent ? '-prior-absent' : ''}`);
		if (state.priorAbsent) await fs.writeFile(asidePath, '');
		else await writeTree(asidePath, state.aside);
	}
	return { deploymentDir, asidePath };
}

function recorder() {
	const calls = [];
	return { calls, publish: async (component, entry) => void calls.push({ component, entry }) };
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
			configAfter: { package: 'web@2.0.0' },
		});
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n', 'the validated candidate becomes live');
		assert.deepStrictEqual(config.calls, [{ component: 'web', entry: { package: 'web@2.0.0' } }]);
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
			configBefore: { package: 'web@1.0.0' },
			configAfter: { package: 'web@2.0.0' },
		});
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'PREVIOUS\n', 'an unvalidated candidate never goes live');
		assert.deepStrictEqual(
			config.calls,
			[{ component: 'web', entry: { package: 'web@1.0.0' } }],
			'and config is put back, so the next boot cannot reinstall the rejected release'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rolls back from the aside when the candidate is gone entirely', async () => {
		const root = await newRoot('lostcand');
		await stageState(root, 'web', 'd1', {
			journal: true,
			aside: 'PREVIOUS\n',
			configBefore: { package: 'web@1.0.0' },
		});
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(failures.size, 0);
		assert.strictEqual(await readLive(root, 'web'), 'PREVIOUS\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('fails the component closed when neither a live tree nor a rollback record survives', async () => {
		const root = await newRoot('bothgone');
		await stageState(root, 'web', 'd1', { journal: true });
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(failures.size, 1, 'the component is reported, not silently skipped');
		assert.match(failures.get('web').message, /neither a live tree/);
		assert.deepStrictEqual(config.calls, [], 'and no config was published on a state we cannot settle');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('discards a candidate that never activated, leaving the live tree and old config', async () => {
		const root = await newRoot('preb1');
		await stageState(root, 'web', 'd1', {
			live: 'LIVE\n',
			candidate: 'CANDIDATE\n',
			complete: true,
			journal: true,
			configBefore: { package: 'web@1.0.0' },
			configAfter: { package: 'web@2.0.0' },
		});
		const config = recorder();

		await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		assert.deepStrictEqual(config.calls, [{ component: 'web', entry: { package: 'web@1.0.0' } }]);
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('finishes the tail when the candidate is already live', async () => {
		const root = await newRoot('postb2');
		await stageState(root, 'web', 'd1', {
			live: 'CANDIDATE\n',
			journal: true,
			aside: 'PREVIOUS\n',
			configAfter: { package: 'web@2.0.0' },
		});
		const config = recorder();

		await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n', 'a completed activation is not reverted');
		assert.deepStrictEqual(config.calls, [{ component: 'web', entry: { package: 'web@2.0.0' } }]);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('treats a candidate with no journal as build residue and touches no config', async () => {
		const root = await newRoot('nojournal');
		await stageState(root, 'web', 'd1', { live: 'LIVE\n', candidate: 'ABANDONED\n' });
		const config = recorder();

		await recoverInterruptedActivations(root, config.publish);

		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n');
		assert.deepStrictEqual(config.calls, []);
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
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

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
			journal: JSON.stringify({ v: 99, component: 'web', candidateId: 'd1', configBefore: null, configAfter: null }),
		});

		const failures = await recoverInterruptedActivations(root, recorder().publish);

		assert.strictEqual(failures.size, 1);
		assert.match(failures.get('web').message, /version 99, expected 1/);
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
			configAfter: { package: 'healthy@2.0.0' },
		});
		const config = recorder();

		const failures = await recoverInterruptedActivations(root, config.publish);

		assert.deepStrictEqual([...failures.keys()], ['broken'], 'only the affected component is reported');
		assert.strictEqual(await readLive(root, 'healthy'), 'CANDIDATE\n', 'the healthy sibling still settles');
		assert.deepStrictEqual(config.calls, [{ component: 'healthy', entry: { package: 'healthy@2.0.0' } }]);
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('activation transaction', () => {
	it('swaps the candidate in, publishes config, and clears its own records', async () => {
		const root = await newRoot('happy');
		await writeTree(path.join(root, 'web'), 'LIVE\n');
		await writeTree(candidateApplicationPath(path.join(root, 'web'), 'd1'), 'CANDIDATE\n');
		const app = new Application({ name: 'web' });
		app.dirPath = path.join(root, 'web');
		const config = recorder();

		await activateCandidateApplication(app, 'd1', {
			configBefore: { package: 'web@1.0.0' },
			configAfter: { package: 'web@2.0.0' },
			publishConfig: (entry) => config.publish('web', entry),
		});

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n');
		assert.deepStrictEqual(config.calls, [{ component: 'web', entry: { package: 'web@2.0.0' } }]);
		assert.strictEqual(existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1')), false, 'staging is cleaned up');
		assert.strictEqual(
			existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')),
			false,
			'and the version it displaced is swept rather than accumulating per deploy'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('restores the previous version when publishing config fails', async () => {
		const root = await newRoot('configfail');
		await writeTree(path.join(root, 'web'), 'LIVE\n');
		await writeTree(candidateApplicationPath(path.join(root, 'web'), 'd1'), 'CANDIDATE\n');
		const app = new Application({ name: 'web' });
		app.dirPath = path.join(root, 'web');

		await assert.rejects(
			() =>
				activateCandidateApplication(app, 'd1', {
					configAfter: { package: 'web@2.0.0' },
					publishConfig: async () => {
						throw new Error('config volume is read-only');
					},
				}),
			/config volume is read-only/
		);

		// The whole point of ordering config last: a config failure cannot leave the new tree serving.
		assert.strictEqual(await readLive(root, 'web'), 'LIVE\n', 'the previous version is serving again');
		assert.strictEqual(
			await fs.readFile(path.join(candidateApplicationPath(path.join(root, 'web'), 'd1'), 'index.js'), 'utf8'),
			'CANDIDATE\n',
			'and the candidate is back where it was, so the deploy can be retried'
		);
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
		const config = recorder();

		await activateCandidateApplication(app, 'd1', {
			configAfter: { package: 'web@1.0.0' },
			publishConfig: (entry) => config.publish('web', entry),
		});

		assert.strictEqual(await readLive(root, 'web'), 'CANDIDATE\n');
		assert.strictEqual(app.isNewComponent, true, 'and it is recognized as a new component');
		await fs.rm(root, { recursive: true, force: true });
	});
});
