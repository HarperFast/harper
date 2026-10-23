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
const { deployComponent, getComponents } = require('#js/components/operations');
const { handleListDeployments, handleGetDeployment } = require('#src/components/deploymentOperations');
const { stagingRetentionMaxCountOf } = require('#src/components/Application');
const {
	formatDeploymentProvenance,
	parseDeploymentPreview,
	parseDeploymentProvenance,
	previewExpiresAtMs,
} = require('#src/components/deploymentProvenance');
const { assertPreviewCapacity, listLocalPreviews, sweepExpiredPreviews } = require('#src/components/previews');
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
			assert.equal(validator.deployComponentValidator({ ...base, preview: { app: 'shop', pr: 1 } }), undefined);
		});

		for (const [description, value] of [
			['no app', { pr: 1 }],
			['no PR number', { app: 'shop' }],
			['a PR number that is not a positive integer', { app: 'shop', pr: '12' }],
			['a sha that is not hex', { app: 'shop', pr: 1, sha: 'not-a-sha' }],
			['an expiresAt that is not a date', { app: 'shop', pr: 1, expiresAt: 'tomorrow' }],
			['an unknown field', { app: 'shop', pr: 1, owner: 'x' }],
			['an app the project does not belong to', { app: 'docs', pr: 1 }],
			['another PR number than the project names', { app: 'shop', pr: 2 }],
			['an app that is only a prefix of the name', { app: 'shop-pr', pr: 1 }],
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

		it('drops only the previews whose expiresAt has passed, and keeps going past a failed drop', async () => {
			const dropped = [];
			const failing = [live('shop-pr-0', 0, 0, 0), ...previews];
			const result = await sweepExpiredPreviews(
				async (component) => {
					if (component === 'shop-pr-0') throw new Error('boom');
					dropped.push(component);
				},
				Date.now(),
				failing,
				async (component) => failing.find((entry) => entry.component === component)
			);
			assert.deepStrictEqual(dropped, ['shop-pr-1']);
			assert.deepStrictEqual(result, ['shop-pr-1']);
		});

		it('skips a preview whose release changed after the listing, or is gone', async () => {
			const dropped = [];
			const drop = async (component) => dropped.push(component);
			const renewed = { ...previews[0], deploymentId: 'd-renewed' };
			await sweepExpiredPreviews(drop, Date.now(), previews, async () => renewed);
			await sweepExpiredPreviews(drop, Date.now(), previews, async () => undefined);
			assert.deepStrictEqual(dropped, []);
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
