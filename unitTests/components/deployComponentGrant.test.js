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
});
