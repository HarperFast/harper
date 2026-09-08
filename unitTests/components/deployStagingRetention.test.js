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
	dropComponentDirectory,
	getStagingRetentionMaxCount,
	prepareApplication,
	pruneDormantBuilds,
	recoverInterruptedActivations,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const {
	withComponentPreparationLock,
	ComponentPreparationLockTimeoutError,
} = require('#src/components/componentPreparationLock');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

async function newRoot(label) {
	return fs.mkdtemp(path.join(os.tmpdir(), `staging-retention-${label}-`));
}

/**
 * Plant one `.deploy-staging/<id>` directory. By default it is a DORMANT build: `.complete`, the owner's
 * tree, the sidecar, and no journal. `completedAt` sets the `.complete` mtime, which is what retention
 * orders by.
 */
async function plant(root, component, id, state = {}) {
	const deploymentDir = path.join(root, DEPLOY_STAGING_DIR, id);
	await fs.mkdir(deploymentDir, { recursive: true });
	if (state.tree !== false) {
		if (state.tree === 'symlink') {
			const target = path.join(root, `${id}-source`);
			await fs.mkdir(target, { recursive: true });
			await fs.symlink(target, path.join(deploymentDir, component), 'dir');
		} else {
			await fs.mkdir(path.join(deploymentDir, component), { recursive: true });
			await fs.writeFile(path.join(deploymentDir, component, 'index.js'), `// ${id}\n`);
		}
	}
	if (state.sidecar !== false) await fs.writeFile(path.join(deploymentDir, '.component'), component);
	if (state.complete !== false) {
		const marker = path.join(deploymentDir, '.complete');
		await fs.writeFile(marker, '');
		if (state.completedAt !== undefined) await fs.utimes(marker, state.completedAt, state.completedAt);
	}
	if (state.journal) {
		await fs.writeFile(
			path.join(deploymentDir, '.activation.json'),
			JSON.stringify({ v: 1, component, candidateId: id })
		);
	}
	if (state.unsettled) await fs.writeFile(path.join(deploymentDir, '.unsettled'), 'stale verdict');
	return deploymentDir;
}

async function stagedIds(root) {
	return (await fs.readdir(path.join(root, DEPLOY_STAGING_DIR)).catch(() => [])).sort();
}

function failingDeployOf(root, component) {
	const app = new Application({
		name: component,
		payload: Readable.from(
			(async function* () {
				yield Buffer.from('not a tarball');
				throw new Error('payload delivery failed');
			})()
		),
	});
	app.dirPath = path.join(root, component);
	return app;
}

describe('staged build retention', () => {
	afterEach(() => env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, undefined));

	describe('getStagingRetentionMaxCount', () => {
		it('defaults to 5 when unset, null, blank, or not a number', () => {
			for (const value of [undefined, null, '', '   ', true, false, [], {}, 'five', NaN, Infinity, -1, '-3']) {
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, value);
				assert.strictEqual(getStagingRetentionMaxCount(), 5, `for ${JSON.stringify(value)}`);
			}
		});

		it('accepts a number or numeric string, floors fractions, and lets 0 mean keep none', () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 2);
			assert.strictEqual(getStagingRetentionMaxCount(), 2);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, '3');
			assert.strictEqual(getStagingRetentionMaxCount(), 3);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 2.9);
			assert.strictEqual(getStagingRetentionMaxCount(), 2);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 0);
			assert.strictEqual(getStagingRetentionMaxCount(), 0);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, '0');
			assert.strictEqual(getStagingRetentionMaxCount(), 0);
		});
	});

	describe('at boot', () => {
		it('keeps a complete build nobody activated and still removes an incomplete one', async () => {
			const root = await newRoot('keep-complete');
			await plant(root, 'web', 'd-complete');
			await plant(root, 'web', 'd-linked', { tree: 'symlink' });
			await plant(root, 'web', 'd-partial', { complete: false });
			await plant(root, 'web', 'd-swept', { tree: false }); // what a settled sweep that failed leaves

			const failures = await recoverInterruptedActivations(root);

			assert.strictEqual(failures.size, 0);
			assert.deepStrictEqual(await stagedIds(root), ['d-complete', 'd-linked']);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('bounds each component to the newest maxCount builds without counting its neighbours', async () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 2);
			const root = await newRoot('bound');
			await plant(root, 'web', 'd-oldest', { completedAt: 1_000 });
			await plant(root, 'web', 'd-middle', { completedAt: 2_000 });
			await plant(root, 'web', 'd-newest', { completedAt: 3_000 });
			await plant(root, 'api', 'd-api', { completedAt: 500 });

			const failures = await recoverInterruptedActivations(root);

			assert.strictEqual(failures.size, 0);
			assert.deepStrictEqual(await stagedIds(root), ['d-api', 'd-middle', 'd-newest']);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('breaks a completion-time tie by deployment id so concurrent passes evict the same build', async () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 1);
			const root = await newRoot('tie');
			await plant(root, 'web', 'd-b', { completedAt: 1_000 });
			await plant(root, 'web', 'd-a', { completedAt: 1_000 });

			await recoverInterruptedActivations(root);

			assert.deepStrictEqual(await stagedIds(root), ['d-a']);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('keeps none when maxCount is 0', async () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 0);
			const root = await newRoot('zero');
			await plant(root, 'web', 'd-1');
			await plant(root, 'web', 'd-2');

			await recoverInterruptedActivations(root);

			assert.deepStrictEqual(await stagedIds(root), []);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('removes a complete build carrying a stale unsettled verdict, so workers stop refusing it', async () => {
			const root = await newRoot('stale-verdict');
			await plant(root, 'web', 'd-verdict', { unsettled: true });

			const failures = await recoverInterruptedActivations(root);

			assert.strictEqual(failures.size, 0);
			assert.deepStrictEqual(await stagedIds(root), []);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('takes no lock for a component within its bound, so a held lock does not defer it', async function () {
			this.timeout(10000);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 2);
			const root = await newRoot('steady-state');
			await plant(root, 'web', 'd-1', { completedAt: 1_000 });
			await plant(root, 'web', 'd-2', { completedAt: 2_000 });

			let failures;
			await withComponentPreparationLock(
				path.join(root, 'web'),
				async () => {
					failures = await recoverInterruptedActivations(root);
				},
				{ purpose: 'test-deploy' }
			);

			assert.strictEqual(failures.size, 0, 'a component with nothing to prune is never deferred by retention');
			assert.deepStrictEqual(await stagedIds(root), ['d-1', 'd-2']);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('defers the component instead of pruning while a deploy holds its lock, and deletes nothing', async function () {
			this.timeout(10000);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 1);
			const root = await newRoot('held-lock');
			await plant(root, 'web', 'd-1', { completedAt: 1_000 });
			await plant(root, 'web', 'd-2', { completedAt: 2_000 });

			let failures;
			await withComponentPreparationLock(
				path.join(root, 'web'),
				async () => {
					failures = await recoverInterruptedActivations(root);
				},
				{ purpose: 'test-deploy' }
			);

			assert.ok(failures.get('web') instanceof ComponentPreparationLockTimeoutError, 'deferred, not failed');
			assert.deepStrictEqual(await stagedIds(root), ['d-1', 'd-2'], 'nothing was removed behind the lock');
			assert.ok(!existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd-1', '.unsettled')), 'and no verdict was written');
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('pruneDormantBuilds', () => {
		it('re-checks for a journal before removing, so a build activated since the scan survives', async () => {
			const root = await newRoot('recheck');
			const builds = [];
			for (const [id, completedAt] of [
				['d-old', 1_000],
				['d-mid', 2_000],
				['d-new', 3_000],
			]) {
				const deploymentDirPath = await plant(root, 'web', id, { completedAt });
				builds.push({ deploymentDirPath, deploymentId: id, completedAt });
			}
			// The scan saw no journal here; a deploy since then is activating this very build.
			await fs.writeFile(
				path.join(root, DEPLOY_STAGING_DIR, 'd-old', '.activation.json'),
				JSON.stringify({ v: 1, component: 'web', candidateId: 'd-old' })
			);

			await pruneDormantBuilds('web', builds, 1);

			assert.deepStrictEqual(await stagedIds(root), ['d-new', 'd-old']);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('does not throw when a build cannot be removed', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
			const root = await newRoot('unremovable');
			const staging = path.join(root, DEPLOY_STAGING_DIR);
			const deploymentDirPath = await plant(root, 'web', 'd-stuck');
			await fs.chmod(staging, 0o500);
			try {
				await pruneDormantBuilds('web', [{ deploymentDirPath, deploymentId: 'd-stuck', completedAt: 1 }], 0);
			} finally {
				await fs.chmod(staging, 0o700);
			}
			assert.deepStrictEqual(await stagedIds(root), ['d-stuck']);
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('on drop', () => {
		it("reclaims the dropped component's dormant builds and leaves its neighbour's alone", async () => {
			const root = await newRoot('drop');
			await plant(root, 'web', 'd-web-1');
			await plant(root, 'web', 'd-web-2');
			await plant(root, 'api', 'd-api');
			await fs.mkdir(path.join(root, 'web'), { recursive: true });

			await dropComponentDirectory(path.join(root, 'web'), 'web');

			assert.ok(!existsSync(path.join(root, 'web')));
			assert.deepStrictEqual(await stagedIds(root), ['d-api']);
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('on the deploy path', () => {
		it('bounds this component before building, protects its neighbours, and surfaces the deploy error', async () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 1);
			const root = await newRoot('deploy-path');
			await plant(root, 'web', 'd-old', { completedAt: 1_000 });
			await plant(root, 'web', 'd-new', { completedAt: 2_000 });
			await plant(root, 'web', 'd-partial', { complete: false, completedAt: 3_000 });
			await plant(root, 'api', 'd-api-old', { completedAt: 1 });
			await plant(root, 'api', 'd-api-new', { completedAt: 2 });
			await fs.mkdir(path.join(root, 'web'), { recursive: true });
			await fs.writeFile(path.join(root, 'web', 'index.js'), 'LIVE\n');

			await assert.rejects(() => prepareApplication(failingDeployOf(root, 'web')), /payload delivery failed/);

			assert.strictEqual(await fs.readFile(path.join(root, 'web', 'index.js'), 'utf8'), 'LIVE\n');
			// `web` is bounded to its newest; residue on the deploy path is left to boot, as before; `api` is
			// not this deploy's business.
			assert.deepStrictEqual(await stagedIds(root), ['d-api-new', 'd-api-old', 'd-new', 'd-partial']);
			await fs.rm(root, { recursive: true, force: true });
		});
	});
});
