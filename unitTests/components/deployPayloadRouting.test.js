'use strict';

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const validator = require('#js/components/operationsValidation');
const { deployComponent } = require('#js/components/operations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const {
	preserveRootConfig,
	removeDeployedComponents,
	rootConfigEntry,
	setRootConfigEntry,
} = require('../rootConfigFixture.js');

describe('deploy_component payload routing (harper#3043)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	removeDeployedComponents();
	let workDirectory;
	let payload;

	before(async () => {
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-payload-routing-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'preview', version: '1.0.0' }));
		payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
	});

	after(async () => {
		resetRestartNeeded();
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	const deploy = (request) => deployComponent({ operation: 'deploy_component', payload, restart: false, ...request });

	it('accepts host and urlPath without a package', () => {
		assert.strictEqual(
			validator.deployComponentValidator({ project: 'shop-pr-12', host: 'pr-12.example.com' }),
			undefined
		);
		assert.strictEqual(validator.deployComponentValidator({ project: 'shop-pr-12', urlPath: '/preview' }), undefined);
	});

	it('publishes host, urlPath and branchedDatabases on the entry of a payload deploy', async () => {
		await deploy({ project: 'shop-pr-1', host: 'pr-1.app.example.com', urlPath: '/shop', branchedDatabases: true });

		assert.deepStrictEqual(rootConfigEntry('shop-pr-1'), {
			host: 'pr-1.app.example.com',
			urlPath: '/shop',
			branchedDatabases: true,
		});
	});

	it('keeps every routing key a redeploy omits, and the keys it does not own', async () => {
		setRootConfigEntry('shop-pr-2', {
			package: 'npm:shop@1',
			host: 'pr-2.app.example.com',
			branchedDatabases: ['data'],
			loadComponent: true,
		});

		await deploy({ project: 'shop-pr-2', urlPath: '/shop' });
		assert.deepStrictEqual(rootConfigEntry('shop-pr-2'), {
			host: 'pr-2.app.example.com',
			branchedDatabases: ['data'],
			loadComponent: true,
			urlPath: '/shop',
		});

		await deploy({ project: 'shop-pr-2' });
		assert.deepStrictEqual(
			rootConfigEntry('shop-pr-2'),
			{ host: 'pr-2.app.example.com', branchedDatabases: ['data'], loadComponent: true, urlPath: '/shop' },
			'a payload deploy that sets nothing leaves routing as it was'
		);
	});

	it('publishes isolated on a peer, which leaves admission to the origin', async () => {
		await deploy({ project: 'shop-pr-3', isolated: true, host: 'pr-3.app.example.com', _deploymentId: randomUUID() });

		assert.deepStrictEqual(rootConfigEntry('shop-pr-3'), { host: 'pr-3.app.example.com', isolated: true });
	});

	it('admits isolation on the origin, and a refusal leaves the entry as it was', async () => {
		setRootConfigEntry('shop-pr-4', { host: 'pr-4.app.example.com' });

		await assert.rejects(deploy({ project: 'shop-pr-4', isolated: true }), (error) => {
			assert.strictEqual(error.statusCode, 409);
			assert.match(error.message, /Cannot deploy 'shop-pr-4' as an isolated application/);
			return true;
		});
		assert.deepStrictEqual(rootConfigEntry('shop-pr-4'), { host: 'pr-4.app.example.com' });
	});

	it('leaves the entry as it was when the build fails', async () => {
		setRootConfigEntry('shop-pr-5', { host: 'pr-5.app.example.com' });

		await assert.rejects(
			deploy({
				project: 'shop-pr-5',
				host: 'other.app.example.com',
				payload: Buffer.from('not a tarball').toString('base64'),
			})
		);
		assert.deepStrictEqual(rootConfigEntry('shop-pr-5'), { host: 'pr-5.app.example.com' });
	});

	it('refuses, before anything is journaled, routing it would copy from a malformed entry', async () => {
		setRootConfigEntry('shop-pr-7', { host: 7 });

		await assert.rejects(
			deploy({ project: 'shop-pr-7', urlPath: '/shop' }),
			/Invalid 'host' for application shop-pr-7/
		);
		assert.deepStrictEqual(rootConfigEntry('shop-pr-7'), { host: 7 });
	});

	it('publishes what a stage recorded only when its build is activated', async () => {
		setRootConfigEntry('shop-pr-6', { host: 'old.app.example.com' });
		const staged = await deploy({
			project: 'shop-pr-6',
			host: 'pr-6.app.example.com',
			branchedDatabases: ['data'],
			activate: false,
			restart: undefined,
		});
		assert.deepStrictEqual(rootConfigEntry('shop-pr-6'), { host: 'old.app.example.com' }, 'nothing is live yet');

		// What the stage recorded wins over an edit made before the activation, as a package stage's entry does.
		setRootConfigEntry('shop-pr-6', { host: 'edited.app.example.com', urlPath: '/edited' });
		await deployComponent({ operation: 'deploy_component', project: 'shop-pr-6', deployment_id: staged.deployment_id });

		assert.deepStrictEqual(rootConfigEntry('shop-pr-6'), { host: 'pr-6.app.example.com', branchedDatabases: ['data'] });
	});
});
