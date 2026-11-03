'use strict';

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { deployComponent, getComponents } = require('#js/components/operations');
const { handleListDeployments, handleGetDeployment } = require('#src/components/deploymentOperations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { preserveRootConfig, removeDeployedComponents, rootConfigEntry } = require('../rootConfigFixture.js');

const grant = {
	names: ['grant-pr-*'],
	constraints: { hostSuffix: '.app.example.com', branchedDatabases: 'required' },
};
const previewUser = (component_deploy = grant) => ({
	username: 'grant-preview',
	role: { role: 'grant-preview', permission: { super_user: false, component_deploy } },
});
const superUser = { username: 'admin', role: { role: 'super_user', permission: { super_user: true } } };

describe('deploy_component under a component grant (harper#3046)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	removeDeployedComponents();
	let workDirectory;
	let payload;

	before(async () => {
		await testUtils.ensureSystemTables();
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-component-grant-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'preview', version: '1.0.0' }));
		payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
	});

	after(async () => {
		resetRestartNeeded();
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	const deploy = (request, hdb_user = previewUser()) =>
		deployComponent({ operation: 'deploy_component', payload, restart: false, hdb_user, ...request });

	it('deploys a covered component that satisfies the constraints', async () => {
		const response = await deploy({
			project: 'grant-pr-1',
			host: 'pr-1.app.example.com',
			branchedDatabases: ['data'],
		});
		assert.strictEqual(response.message, 'Successfully deployed: grant-pr-1');
		assert.deepStrictEqual(rootConfigEntry('grant-pr-1'), {
			host: 'pr-1.app.example.com',
			branchedDatabases: ['data'],
		});
	});

	for (const [description, request, message] of [
		['a host outside the suffix', { host: 'shop.example.com', branchedDatabases: true }, /host under/],
		['no host', { branchedDatabases: true }, /host under/],
		['no branchedDatabases', { host: 'pr-2.app.example.com' }, /branchedDatabases/],
	]) {
		it(`refuses ${description} before anything is written`, async () => {
			await assert.rejects(deploy({ project: 'grant-pr-2', ...request }), (error) => {
				assert.strictEqual(error.statusCode, 403);
				assert.match(error.message, message);
				return true;
			});
			assert.strictEqual(rootConfigEntry('grant-pr-2'), undefined);
		});
	}

	it('refuses a deploy that is not isolated when the grant requires it', async () => {
		const isolatedGrant = { names: ['grant-pr-*'], constraints: { isolated: true } };
		await assert.rejects(deploy({ project: 'grant-pr-3' }, previewUser(isolatedGrant)), (error) => {
			assert.strictEqual(error.statusCode, 403);
			assert.match(error.message, /isolated application/);
			return true;
		});
		// Past the grant, the deploy reaches the instance's own isolation admission.
		await assert.rejects(deploy({ project: 'grant-pr-3', isolated: true }, previewUser(isolatedGrant)), (error) => {
			assert.strictEqual(error.statusCode, 409);
			return true;
		});
	});

	it('enforces the constraints on a request that names a deployment id, and skips them only for a replicated one', async () => {
		const { REPLICATED_FROM } = require('#src/utility/hdbTerms');
		const _deploymentId = randomUUID();
		await assert.rejects(deploy({ project: 'grant-pr-4', _deploymentId }), { statusCode: 403 });
		const replicated = { operation: 'deploy_component', payload, restart: false, project: 'grant-pr-4' };
		replicated._deploymentId = randomUUID();
		replicated.hdb_user = previewUser();
		replicated[REPLICATED_FROM] = 'node-a';
		const response = await deployComponent(replicated);
		assert.strictEqual(response.message, 'Successfully deployed: grant-pr-4', 'a peer applies what its origin allowed');
	});

	it('checks a redeploy against the routing it keeps', async () => {
		await deploy({ project: 'grant-pr-1', host: 'pr-1.app.example.com', branchedDatabases: ['data'] });
		await deploy({ project: 'grant-pr-1' });
		await assert.rejects(deploy({ project: 'grant-pr-1', host: 'elsewhere.example.com' }), /host under/);
		assert.strictEqual(rootConfigEntry('grant-pr-1').host, 'pr-1.app.example.com');
	});

	it('shows only covered components and their deployments', async () => {
		await deploy({ project: 'grant-pr-1', host: 'pr-1.app.example.com', branchedDatabases: ['data'] });
		await deploy({ project: 'grant-other', host: 'x.example.com' }, superUser);

		const names = (await getComponents({ hdb_user: previewUser() })).entries.map((entry) => entry.name);
		assert.ok(names.includes('grant-pr-1'));
		assert.ok(!names.includes('grant-other'));
		assert.ok((await getComponents({ hdb_user: superUser })).entries.some((entry) => entry.name === 'grant-other'));

		const { deployments } = await handleListDeployments({ hdb_user: previewUser() });
		assert.ok(deployments.length > 0);
		assert.ok(deployments.every((deployment) => deployment.project.startsWith('grant-pr-')));
		const other = (await handleListDeployments({ project: 'grant-other' })).deployments[0];
		await assert.rejects(handleGetDeployment({ deployment_id: other.deployment_id, hdb_user: previewUser() }), {
			statusCode: 403,
		});
		const own = deployments[0];
		assert.strictEqual(
			(await handleGetDeployment({ deployment_id: own.deployment_id, hdb_user: previewUser() })).project,
			own.project
		);
	});
	describe('under a preview grant (harper#3042)', () => {
		const { listLocalPreviews } = require('#src/components/previews');
		const env = require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const DAY = 24 * 60 * 60 * 1000;
		const previewGrant = (app, constraints = {}) => ({
			names: [`${app}-pr-*`],
			constraints: { hostSuffix: '.app.example.com', preview: 'required', ...constraints },
		});
		const metadata = (app, pr, expiresInDays = 3) => ({
			app,
			pr,
			expiresAt: new Date(Date.now() + expiresInDays * DAY).toISOString(),
		});
		const deployPreview = (app, pr, grant, request = {}) =>
			deploy(
				{ project: `${app}-pr-${pr}`, host: `${app}-${pr}.app.example.com`, preview: metadata(app, pr), ...request },
				previewUser(grant)
			);

		it('refuses a deploy that is not a preview before anything is written', async () => {
			await assert.rejects(deployPreview('pa', 1, previewGrant('pa'), { preview: undefined }), (error) => {
				assert.strictEqual(error.statusCode, 403);
				assert.match(error.message, /as a PR preview/);
				return true;
			});
			assert.strictEqual(rootConfigEntry('pa-pr-1'), undefined);
			assert.strictEqual((await handleListDeployments({ project: 'pa-pr-1' })).deployments.length, 0);
		});

		it("refuses a preview of an application the grant's pattern only happens to cover", async () => {
			// `pb-pr-pr-3` is covered by `pb-pr-*`, but as a preview of `pb-pr` it would count against another cap.
			await assert.rejects(
				deploy(
					{ project: 'pb-pr-pr-3', host: 'x.app.example.com', preview: metadata('pb-pr', 3) },
					previewUser(previewGrant('pb'))
				),
				/a preview of an application this role's component grant previews/
			);
		});

		it('clamps an expiry past maxTtlDays, and leaves one within it as it was', async () => {
			const grant = previewGrant('pc', { maxTtlDays: 1 });
			const before = Date.now();
			const response = await deployPreview('pc', 1, grant, { preview: metadata('pc', 1, 30) });
			const expiresAt = Date.parse(
				(await handleGetDeployment({ deployment_id: response.deployment_id })).preview.expiresAt
			);
			assert.ok(expiresAt >= before + DAY && expiresAt <= Date.now() + DAY, `clamped to a day: ${expiresAt}`);
			const live = (await listLocalPreviews()).find((entry) => entry.component === 'pc-pr-1');
			assert.strictEqual(Date.parse(live.preview.expiresAt), expiresAt, 'the release records the clamped expiry');

			const within = metadata('pc', 2, 0.5);
			const kept = await deployPreview('pc', 2, grant, { preview: within });
			assert.strictEqual(
				(await handleGetDeployment({ deployment_id: kept.deployment_id })).preview.expiresAt,
				within.expiresAt
			);
		});

		it('holds maxPreviews in place of deployment.previews.maxPerApplication, a request naming a deployment id included', async () => {
			const one = previewGrant('pd', { maxPreviews: 1 });
			await deployPreview('pd', 1, one);
			await assert.rejects(deployPreview('pd', 2, one), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(error.message, /oldest is 'pd-pr-1'/);
				return true;
			});
			await assert.rejects(deployPreview('pd', 2, one, { _deploymentId: randomUUID() }), { statusCode: 409 });
			await deployPreview('pd', 1, one);

			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, 1);
			try {
				await deployPreview('pd', 2, previewGrant('pd', { maxPreviews: 2 }));
			} finally {
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION, undefined);
			}
		});

		it("refuses to activate a staged build that is not a preview, or that expires past the grant's bound", async () => {
			const stage = (pr, preview) =>
				deploy(
					{ project: `pe-pr-${pr}`, host: `pe-${pr}.app.example.com`, activate: false, restart: undefined, preview },
					superUser
				);
			const activate = (pr, deployment_id) =>
				deployComponent({
					operation: 'deploy_component',
					project: `pe-pr-${pr}`,
					deployment_id,
					hdb_user: previewUser(previewGrant('pe', { maxTtlDays: 1 })),
				});
			const plain = await stage(1, undefined);
			await assert.rejects(activate(1, plain.deployment_id), /as a PR preview/);
			const late = await stage(2, metadata('pe', 2, 30));
			await assert.rejects(activate(2, late.deployment_id), /later than this role's component grant allows/);
			const due = await stage(3, metadata('pe', 3, 0.5));
			await activate(3, due.deployment_id);
			assert.ok((await listLocalPreviews()).some((entry) => entry.component === 'pe-pr-3'));
		});

		it('checks a release that is already live before activating it again', async () => {
			const live = await deploy({ project: 'pf-pr-1', host: 'pf-1.app.example.com' }, superUser);
			await assert.rejects(
				deployComponent({
					operation: 'deploy_component',
					project: 'pf-pr-1',
					deployment_id: live.deployment_id,
					hdb_user: previewUser(previewGrant('pf')),
				}),
				{ statusCode: 403, message: /as a PR preview/ }
			);
		});

		it("stamps the grant's identity generation on the preview it deploys, whatever the request says", async () => {
			const grant = previewGrant('ph', { generation: 'ph-gen-1' });
			const response = await deployPreview('ph', 1, grant, {
				preview: { ...metadata('ph', 1), generation: 'forged-generation' },
			});
			assert.strictEqual(
				(await handleGetDeployment({ deployment_id: response.deployment_id })).preview.generation,
				'ph-gen-1'
			);
			const live = (await listLocalPreviews()).find((entry) => entry.component === 'ph-pr-1');
			assert.strictEqual(live.preview.generation, 'ph-gen-1', 'the release carries it to every node');
		});

		it('refuses, on a peer, to apply a preview whose identity generation was revoked on that peer', async () => {
			const { REPLICATED_FROM } = require('#src/utility/hdbTerms');
			const { fencePreviewGeneration } = require('#src/components/previews');
			await fencePreviewGeneration('pi', 'pi-gen-1');
			const replicated = (pr, generation) => {
				const request = {
					operation: 'deploy_component',
					payload,
					restart: false,
					project: `pi-pr-${pr}`,
					preview: { ...metadata('pi', pr), generation },
					_deploymentId: randomUUID(),
					hdb_user: superUser,
				};
				request[REPLICATED_FROM] = 'node-a';
				return deployComponent(request);
			};
			await assert.rejects(replicated(1, 'pi-gen-1'), { statusCode: 403, message: /previews of pi .* were disabled/ });
			assert.ok(!(await listLocalPreviews()).some((entry) => entry.component === 'pi-pr-1'));
			await replicated(2, 'pi-gen-2');
		});

		it("refuses a super user's activation of a staged build whose identity generation was revoked", async () => {
			const { fencePreviewGeneration } = require('#src/components/previews');
			const staged = await deploy(
				{
					project: 'pj-pr-1',
					host: 'pj-1.app.example.com',
					activate: false,
					restart: undefined,
					preview: { ...metadata('pj', 1), generation: 'pj-gen-1' },
				},
				superUser
			);
			await fencePreviewGeneration('pj', 'pj-gen-1');
			await assert.rejects(
				deployComponent({
					operation: 'deploy_component',
					project: 'pj-pr-1',
					deployment_id: staged.deployment_id,
					hdb_user: superUser,
				}),
				{ statusCode: 403, message: /previews of pj .* were disabled/ }
			);
		});

		it('refuses to make a preview live once its deployer was revoked during the deploy', async () => {
			const { getUserWithRole } = require('#src/security/user');
			const permission = { super_user: false, component_deploy: previewGrant('pg') };
			const seeded = (active) =>
				testUtils.seedUsers([{ username: 'pg-ci', active, role: { id: 'pg-ci', role: 'pg-ci', permission } }]);
			await seeded(true);
			const deployer = getUserWithRole('pg-ci');
			await seeded(false);
			try {
				await assert.rejects(
					deploy({ project: 'pg-pr-1', host: 'pg-1.app.example.com', preview: metadata('pg', 1) }, deployer),
					{ statusCode: 403, message: /changed while it deployed/ }
				);
				assert.ok(!(await listLocalPreviews()).some((entry) => entry.component === 'pg-pr-1'));
			} finally {
				await testUtils.seedUsers();
			}
		});
	});
});
