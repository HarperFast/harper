'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const validator = require('#js/components/operationsValidation');
const {
	deployComponent,
	dropComponent,
	getComponents,
	retryPendingBranchRemovals,
} = require('#js/components/operations');
const { handleListDeployments, handleGetDeployment } = require('#src/components/deploymentOperations');
const { stagingRetentionMaxCountOf } = require('#src/components/Application');
const {
	DEPLOYMENT_PROVENANCE_FILE,
	formatDeploymentProvenance,
	parseDeploymentPreview,
	parseDeploymentProvenance,
	previewExpiresAtMs,
} = require('#src/components/deploymentProvenance');
const {
	admitPreviewActivation,
	assertPreviewCapacity,
	fencePreviewGeneration,
	listLocalPreviews,
	sweepExpiredPreviews,
} = require('#src/components/previews');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { preserveRootConfig, removeDeployedComponents } = require('../rootConfigFixture.js');

const preview = (pr, overrides = {}) => ({
	app: 'shop',
	pr,
	repository: 'acme/shop',
	branch: `feature-${pr}`,
	sha: 'abc1234',
	expiresAt: '2030-01-01T00:00:00.000Z',
	...overrides,
});

describe('PR preview metadata (harper#3048)', () => {
	describe('validation', () => {
		const base = { project: 'shop-pr-1', payload: 'x' };
		it('accepts the documented fields, with expiresAt as an ISO date or epoch milliseconds', () => {
			assert.equal(validator.deployComponentValidator({ ...base, preview: preview(1) }), undefined);
			assert.equal(
				validator.deployComponentValidator({ ...base, preview: preview(1, { expiresAt: 1893456000000 }) }),
				undefined
			);
			const dated = { app: 'shop', pr: 1, expiresAt: 1893456000000 };
			assert.equal(validator.deployComponentValidator({ ...base, preview: dated }), undefined);
		});

		const dated = { expiresAt: 1893456000000 };
		for (const [description, value] of [
			['no app', { pr: 1, ...dated }],
			['no PR number', { app: 'shop', ...dated }],
			['a PR number that is not a positive integer', { app: 'shop', pr: '12', ...dated }],
			['a sha that is not hex', { app: 'shop', pr: 1, sha: 'not-a-sha', ...dated }],
			['an expiresAt that is not a date', { app: 'shop', pr: 1, expiresAt: 'tomorrow' }],
			['no expiresAt, which no sweep would ever reach', { app: 'shop', pr: 1 }],
			['an unknown field', { app: 'shop', pr: 1, owner: 'x', ...dated }],
			['an app the project does not belong to', { app: 'docs', pr: 1, ...dated }],
			['another PR number than the project names', { app: 'shop', pr: 2, ...dated }],
			['an app that is only a prefix of the name', { app: 'shop-pr', pr: 1, ...dated }],
		]) {
			it(`refuses ${description}`, () => assert.ok(validator.deployComponentValidator({ ...base, preview: value })));
		}

		it('refuses it on an activation, whose staged build already recorded its own', () => {
			const deployment_id = '00000000-0000-4000-8000-000000000000';
			assert.ok(validator.deployComponentValidator({ project: 'shop-pr-1', deployment_id, preview: preview(1) }));
		});
	});

	it('rides the provenance of the release, which a reader of the id alone still accepts', () => {
		const raw = formatDeploymentProvenance('shop-pr-1', 'd1', preview(1));
		assert.strictEqual(parseDeploymentProvenance(raw, 'shop-pr-1'), 'd1');
		assert.deepStrictEqual(parseDeploymentPreview(raw, 'shop-pr-1'), preview(1));
		assert.strictEqual(parseDeploymentPreview(raw, 'other'), undefined);
		assert.strictEqual(parseDeploymentPreview(formatDeploymentProvenance('shop', 'd2'), 'shop'), undefined);
		assert.strictEqual(previewExpiresAtMs(preview(1)), Date.parse('2030-01-01T00:00:00.000Z'));
		assert.strictEqual(previewExpiresAtMs(preview(1, { expiresAt: 'never' })), undefined);
	});

	describe('the cap and the sweep', () => {
		const live = (component, pr, deployedAtMs, expiresAt) => ({
			component,
			deploymentId: `d-${component}`,
			preview: preview(pr, { expiresAt }),
			deployedAtMs,
		});
		const previews = [live('shop-pr-1', 1, 1000, 0), live('shop-pr-2', 2, 500, Date.parse('2099-01-01T00:00:00.000Z'))];

		it('refuses a new preview of an application at its cap, naming the oldest', async () => {
			await assert.rejects(assertPreviewCapacity('shop-pr-3', 'shop', 2, previews), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(error.message, /oldest is 'shop-pr-2' \(PR 2\)/);
				return true;
			});
		});

		it('admits a redeploy of a live preview, another application, or any preview with no cap', async () => {
			await assertPreviewCapacity('shop-pr-1', 'shop', 2, previews);
			await assertPreviewCapacity('docs-pr-1', 'docs', 2, previews);
			await assertPreviewCapacity('shop-pr-3', 'shop', undefined, previews);
		});

		it('drops only the expired previews, naming the release it listed, and keeps going past a failed drop', async () => {
			const dropped = [];
			const failing = [live('shop-pr-0', 0, 0, 0), ...previews];
			const result = await sweepExpiredPreviews(
				async (component, deploymentId) => {
					if (component === 'shop-pr-0') throw new Error('boom');
					dropped.push([component, deploymentId]);
					return { componentRemoved: true };
				},
				Date.now(),
				failing
			);
			assert.deepStrictEqual(dropped, [['shop-pr-1', 'd-shop-pr-1']]);
			assert.deepStrictEqual(result, ['shop-pr-1']);
		});

		it('does not count a drop the node skipped, nor try one without a release to name', async () => {
			const asked = [];
			const skipped = async (component) => {
				asked.push(component);
				return { componentRemoved: false };
			};
			assert.deepStrictEqual(await sweepExpiredPreviews(skipped, Date.now(), previews), []);
			assert.deepStrictEqual(
				await sweepExpiredPreviews(skipped, Date.now(), [{ ...previews[0], deploymentId: undefined }]),
				[]
			);
			assert.deepStrictEqual(asked, ['shop-pr-1']);
		});
	});

	describe('admission at activation', () => {
		let root;
		beforeEach(async () => {
			root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-admission-'));
		});
		afterEach(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		async function candidate(component, pr, overrides) {
			const dir = path.join(root, '.candidates', component);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, DEPLOYMENT_PROVENANCE_FILE),
				formatDeploymentProvenance(component, `d-${component}`, preview(pr, overrides))
			);
			return dir;
		}
		// The swap: the candidate's provenance lands at the live path.
		const goLive = (component, dir) => async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			await fs.mkdir(path.join(root, component), { recursive: true });
			await fs.copyFile(
				path.join(dir, DEPLOYMENT_PROVENANCE_FILE),
				path.join(root, component, DEPLOYMENT_PROVENANCE_FILE)
			);
		};

		it('lets only one of two concurrent activations take the last slot', async () => {
			const one = await candidate('shop-pr-1', 1);
			const two = await candidate('shop-pr-2', 2);
			const outcomes = await Promise.allSettled([
				admitPreviewActivation('shop-pr-1', one, goLive('shop-pr-1', one), 1, root),
				admitPreviewActivation('shop-pr-2', two, goLive('shop-pr-2', two), 1, root),
			]);
			assert.deepStrictEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
			assert.strictEqual(outcomes.find((outcome) => outcome.status === 'rejected').reason.statusCode, 409);
			assert.strictEqual((await listLocalPreviews(root)).length, 1);
		});

		it('admits a redeploy of a live preview, a build that is not a preview, and anything with no cap', async () => {
			const one = await candidate('shop-pr-1', 1);
			await admitPreviewActivation('shop-pr-1', one, goLive('shop-pr-1', one), 1, root);
			await admitPreviewActivation('shop-pr-1', one, async () => {}, 1, root);
			const plain = path.join(root, '.candidates', 'shop-production');
			await fs.mkdir(plain, { recursive: true });
			await admitPreviewActivation('shop-production', plain, async () => {}, 1, root);
			const two = await candidate('shop-pr-2', 2);
			await admitPreviewActivation('shop-pr-2', two, async () => {}, undefined, root);
		});
	});

	describe('the revocation fence (harper#3613)', () => {
		let root;
		beforeEach(async () => {
			root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-fence-'));
		});
		afterEach(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		async function candidate(component, pr, generation) {
			const dir = path.join(root, '.candidates', component);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, DEPLOYMENT_PROVENANCE_FILE),
				formatDeploymentProvenance(component, `d-${component}`, preview(pr, generation ? { generation } : {}))
			);
			return dir;
		}
		const fenced = (component, dir, activate = async () => {}) =>
			admitPreviewActivation(component, dir, activate, null, root, undefined, undefined, true);

		it('refuses a build whose identity generation was revoked on this node, with no cap', async () => {
			await fencePreviewGeneration('shop', 'g1', root);
			await assert.rejects(fenced('shop-pr-1', await candidate('shop-pr-1', 1, 'g1')), (error) => {
				assert.strictEqual(error.statusCode, 403);
				assert.match(error.message, /'shop-pr-1' was not activated: previews of shop .* were disabled/);
				return true;
			});
			await fenced('shop-pr-2', await candidate('shop-pr-2', 2, 'g2'));
			await fenced('shop-pr-3', await candidate('shop-pr-3', 3));
		});

		it('waits for a swap holding the lock, so what it made live is there when the fence returns', async () => {
			const dir = await candidate('shop-pr-1', 1, 'g1');
			let entered;
			let release;
			const inSwap = new Promise((resolve) => (entered = resolve));
			const gate = new Promise((resolve) => (release = resolve));
			const swap = fenced('shop-pr-1', dir, async () => {
				entered();
				await gate;
				await fs.mkdir(path.join(root, 'shop-pr-1'));
			});
			await inSwap;
			let fenceDone = false;
			const fence = fencePreviewGeneration('shop', 'g1', root).then(() => (fenceDone = true));
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.strictEqual(fenceDone, false, 'the fence waits for the swap');
			release();
			await Promise.all([swap, fence]);
			assert.ok(await fs.stat(path.join(root, 'shop-pr-1')), 'the swap finished before the fence was recorded');
		});

		it('refuses, rather than skipping the fence, when it cannot read what a candidate is', async () => {
			const dir = path.join(root, '.candidates', 'shop-pr-5');
			await fs.mkdir(path.join(dir, DEPLOYMENT_PROVENANCE_FILE), { recursive: true });
			let activated = false;
			await assert.rejects(fenced('shop-pr-5', dir, async () => (activated = true)));
			assert.strictEqual(activated, false);
			await fs.mkdir(path.join(root, '.candidates', 'shop-pr-6'), { recursive: true });
			await fenced('shop-pr-6', path.join(root, '.candidates', 'shop-pr-6'));
		});

		it('keeps every generation it was given, durably, and refuses an unreadable fence', async () => {
			await fencePreviewGeneration('shop', 'g1', root);
			await fencePreviewGeneration('shop', 'g2', root);
			await fencePreviewGeneration('shop', 'g1', root);
			const file = path.join(root, '.preview-revoked', 'shop.json');
			assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), ['g1', 'g2']);
			await fs.writeFile(file, 'not json');
			await assert.rejects(fenced('shop-pr-4', await candidate('shop-pr-4', 4, 'g3')));
		});
	});

	describe('through deploy_component', function () {
		this.timeout(30_000);
		preserveRootConfig();
		removeDeployedComponents();
		let workDirectory;
		let payload;
		const deploy = (request) => deployComponent({ operation: 'deploy_component', payload, restart: false, ...request });

		before(async () => {
			await testUtils.ensureSystemTables();
			workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-preview-'));
			const source = path.join(workDirectory, 'source');
			await fs.mkdir(source);
			await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'preview', version: '1.0.0' }));
			payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
		});

		after(async () => {
			resetRestartNeeded();
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, undefined);
			if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		});

		it('is shown by get_components and list_deployments', async () => {
			const response = await deploy({ project: 'shop-pr-11', preview: preview(11) });

			const entry = (await getComponents()).entries.find((component) => component.name === 'shop-pr-11');
			assert.deepStrictEqual(entry.preview, preview(11));
			const { deployments } = await handleListDeployments({ project: 'shop-pr-11' });
			assert.deepStrictEqual(deployments[0].preview, preview(11));
			assert.ok((await listLocalPreviews()).some((live) => live.component === 'shop-pr-11'));

			const row = await handleGetDeployment({ deployment_id: response.deployment_id });
			assert.strictEqual(row.payload_blob_present, false);
		});

		it('registers the expiry sweep with the cluster scheduler on the primary worker once a preview is live', async () => {
			const { setMainIsWorker, getWorkerIndex } = require('#js/server/threads/manageThreads');
			const engine = require('#src/resources/scheduler/engine');
			const { ensurePreviewSweep, resetPreviewSweepForTests } = require('#src/components/previews');
			const mainWasWorker = getWorkerIndex() === 0;
			await deploy({ project: 'shop-pr-12', preview: preview(12) });
			setMainIsWorker(true);
			resetPreviewSweepForTests();
			try {
				assert.strictEqual(await ensurePreviewSweep(), true);
				assert.deepStrictEqual(engine.getRegisteredJobNames(engine.internalJobOwner('preview-expiry')), ['sweep']);
				await engine.electionSettledForTests();
			} finally {
				engine.stopSchedulerEngine();
				resetPreviewSweepForTests();
				setMainIsWorker(mainWasWorker);
			}
		});

		it('keeps a release that went live after the sweep listed the one that expired', async () => {
			const expired = preview(13, { expiresAt: '2000-01-01T00:00:00.000Z' });
			await deploy({ project: 'shop-pr-13', preview: expired });
			const listed = (await listLocalPreviews()).filter((live) => live.component === 'shop-pr-13');
			const renewed = await deploy({ project: 'shop-pr-13', preview: preview(13) });
			const drop = (project, ifDeploymentId) => dropComponent({ operation: 'drop_component', project, ifDeploymentId });

			assert.deepStrictEqual(await sweepExpiredPreviews(drop, Date.now(), listed), []);
			const [kept] = (await listLocalPreviews()).filter((live) => live.component === 'shop-pr-13');
			assert.strictEqual(kept?.deploymentId, renewed.deployment_id, 'the renewed release is still live');

			const dropped = await drop('shop-pr-13', renewed.deployment_id);
			assert.strictEqual(dropped.componentRemoved, true);
			assert.ok(!(await listLocalPreviews()).some((live) => live.component === 'shop-pr-13'));
		});

		it('discards the fork of a swept preview past a removal that failed, without dropping that preview again (harper#3463)', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0 || process.env.HARPER_STORAGE_ENGINE === 'lmdb') {
				return this.skip(); // forks are RocksDB-only, and root ignores the permission that makes the removal fail
			}
			const { existsSync, chmodSync, mkdirSync, writeFileSync } = require('node:fs');
			const { table, resolveBranchPath } = require('#src/resources/databases');
			const { getOrCreateBranch } = require('#src/resources/branchDatabase');
			const { setMainIsWorker, getWorkerIndex } = require('#js/server/threads/manageThreads');
			const { waitFor } = require('../waitFor.js');
			table({ database: 'previewbase', table: 'Rows', attributes: [{ name: 'id', isPrimaryKey: true }] });
			await deploy({ project: 'shop-pr-14', preview: preview(14, { expiresAt: '2000-01-01T00:00:00.000Z' }) });
			const mainWasWorker = getWorkerIndex() === 0;
			setMainIsWorker(true);
			try {
				await (await getOrCreateBranch('previewbase', 'shop-pr-14')).close();
			} finally {
				setMainIsWorker(mainWasWorker);
			}
			const branchPath = resolveBranchPath('previewbase', 'shop-pr-14');
			const forks = path.dirname(branchPath);
			const hold = path.join(branchPath, 'hold');
			mkdirSync(hold);
			writeFileSync(path.join(hold, 'keep'), '');
			chmodSync(hold, 0o555);
			const drop = (project, ifDeploymentId) => dropComponent({ operation: 'drop_component', project, ifDeploymentId });
			try {
				assert.deepStrictEqual(await sweepExpiredPreviews(drop, Date.now()), ['shop-pr-14']);
				assert.ok(
					!(await listLocalPreviews()).some((live) => live.component === 'shop-pr-14'),
					'no sweep lists it again'
				);
				assert.ok(existsSync(forks), 'its fork is still on disk');
				assert.ok(existsSync(path.join(forks, '`removal-pending`')), "the sweep's drop recorded the removal it owes");
				await retryPendingBranchRemovals?.();
				assert.ok(existsSync(forks), 'a pass cannot remove it either');
			} finally {
				for (const dir of [hold, path.join(`${branchPath}\`removing\``, 'hold')]) {
					if (existsSync(dir)) chmodSync(dir, 0o755);
				}
			}

			await drop('never-here');
			await waitFor(() => !existsSync(forks), { timeout: 10000, interval: 50, message: 'the fork was left on disk' });
		});

		it('is not shown for a deploy that carried none', async () => {
			await deploy({ project: 'shop-production' });
			const entry = (await getComponents()).entries.find((component) => component.name === 'shop-production');
			assert.strictEqual(entry.preview, undefined);
		});

		it('refuses a preview beyond deployment.previews.maxPerApplication before anything is written', async () => {
			await deploy({ project: 'cap-pr-1', preview: preview(1, { app: 'cap' }) });
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, 1);
			try {
				await assert.rejects(
					deploy({ project: 'cap-pr-2', preview: preview(2, { app: 'cap' }) }),
					/oldest is 'cap-pr-1'/
				);
				await deploy({ project: 'cap-pr-1', preview: preview(1, { app: 'cap' }) });
				const { deployments } = await handleListDeployments({ project: 'cap-pr-2' });
				assert.strictEqual(deployments.length, 0, 'no deployment was recorded');
			} finally {
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, undefined);
			}
		});

		it('holds the cap when two staged previews are activated, and still admits a redeploy', async () => {
			const stage = (pr) =>
				deploy({
					project: `staged-pr-${pr}`,
					preview: preview(pr, { app: 'staged' }),
					activate: false,
					restart: undefined,
				});
			const activate = (pr, deployment_id) =>
				deployComponent({ operation: 'deploy_component', project: `staged-pr-${pr}`, deployment_id });
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, 1);
			try {
				const first = await stage(1);
				const second = await stage(2);
				await activate(1, first.deployment_id);
				await assert.rejects(activate(2, second.deployment_id), (error) => {
					assert.strictEqual(error.statusCode, 409);
					assert.match(error.message, /oldest is 'staged-pr-1'/);
					return true;
				});
				const live = (await listLocalPreviews()).filter((entry) => entry.preview.app === 'staged');
				assert.deepStrictEqual(
					live.map((entry) => entry.component),
					['staged-pr-1']
				);
				await deploy({ project: 'staged-pr-1', preview: preview(1, { app: 'staged' }) });
			} finally {
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, undefined);
			}
		});

		describe('per-component build retention (harper#3049)', () => {
			afterEach(() => env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_STAGINGRETENTION_MAXCOUNT, undefined));

			it("keeps one build for a preview, and the instance's count for anything else", async () => {
				await deploy({ project: 'retain-pr-1', preview: preview(1, { app: 'retain' }) });
				await deploy({ project: 'retain-production' });
				const root = env.get(CONFIG_PARAMS.COMPONENTSROOT);

				assert.strictEqual(await stagingRetentionMaxCountOf(root, 'retain-pr-1'), 1);
				assert.strictEqual(await stagingRetentionMaxCountOf(root, 'retain-production'), 5);
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_STAGINGRETENTION_MAXCOUNT, 0);
				assert.strictEqual(await stagingRetentionMaxCountOf(root, 'retain-pr-1'), 0);
				// A displaced release is asked about by its own tree, not by whatever replaced it.
				const displaced = path.join(workDirectory, 'displaced', 'retain-pr-1');
				await fs.cp(path.join(root, 'retain-pr-1'), displaced, { recursive: true });
				await deploy({ project: 'retain-pr-1' });
				assert.strictEqual(await stagingRetentionMaxCountOf(root, 'retain-pr-1'), 5);
				assert.strictEqual(await stagingRetentionMaxCountOf(root, 'retain-pr-1', displaced), 0);
			});
		});
	});
});
