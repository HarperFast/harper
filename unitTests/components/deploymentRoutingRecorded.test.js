'use strict';

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { databases } = require('#src/resources/databases');
const { waitFor } = require('../waitFor.js');
const { deployComponent } = require('#src/components/operations');
const { handleGetDeployment, handleListDeployments } = require('#src/components/deploymentOperations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const {
	preserveRootConfig,
	removeDeployedComponents,
	rootConfigEntry,
	setRootConfigEntry,
} = require('../rootConfigFixture.js');

const NO_ROUTING = { host: null, urlPath: null, isolated: null, branchedDatabases: null };

describe('deployment records carry the routing a release puts back (harper#4077)', function () {
	this.timeout(60_000);
	preserveRootConfig();
	removeDeployedComponents();
	let workDirectory;
	let payload;
	let packageIdentifier;

	before(async () => {
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-routing-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'routed-app', version: '1.0.0' }));
		const packaged = await packageDirectory(source, { skip_node_modules: true });
		payload = packaged.toString('base64');
		const tarball = path.join(workDirectory, 'component.tgz');
		await fs.writeFile(tarball, packaged);
		packageIdentifier = `file:${tarball}`;
		await testUtils.ensureSystemTables();
	});

	after(async () => {
		// A first deploy of a component asks for a restart, which this process never performs.
		resetRestartNeeded();
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	const deploy = (request) => deployComponent({ operation: 'deploy_component', restart: false, ...request });
	const routingOf = async (deploymentId) => (await handleGetDeployment({ deployment_id: deploymentId })).routing;

	it('records null for a payload deploy that sets no routing, since it leaves the entry as it finds it', async () => {
		const project = 'routing-payload-none';
		setRootConfigEntry(project, { branchedDatabases: ['data'] });

		const { deployment_id } = await deploy({ project, payload });

		assert.deepStrictEqual(rootConfigEntry(project), { branchedDatabases: ['data'] });
		const record = await handleGetDeployment({ deployment_id });
		assert.ok('routing' in record, 'a recorded null is returned, not left out');
		assert.strictEqual(record.routing, null);
	});

	it('records every routing key a payload deploy owns, those it keeps from the entry included', async () => {
		const project = 'routing-payload-set';
		setRootConfigEntry(project, { host: 'old.app.example.com' });

		const { deployment_id } = await deploy({ project, payload, branchedDatabases: ['data'] });

		assert.deepStrictEqual(await routingOf(deployment_id), {
			host: 'old.app.example.com',
			urlPath: null,
			isolated: null,
			branchedDatabases: ['data'],
		});
	});

	it("records a package deploy's routing keys, null for each its entry leaves out", async () => {
		const project = 'routing-package';

		const branched = await deploy({ project, package: packageIdentifier, urlPath: '/shop', branchedDatabases: true });
		assert.deepStrictEqual(await routingOf(branched.deployment_id), {
			host: null,
			urlPath: '/shop',
			isolated: null,
			branchedDatabases: true,
		});

		const plain = await deploy({ project, package: packageIdentifier });
		assert.deepStrictEqual(await routingOf(plain.deployment_id), NO_ROUTING);
		assert.deepStrictEqual(rootConfigEntry(project), { package: packageIdentifier });
	});

	it('records on a stage, its activation and a retry of that activation the routing the stage puts back', async () => {
		const project = 'routing-stage';
		setRootConfigEntry(project, { host: 'old.app.example.com' });
		const staged = await deploy({
			project,
			payload,
			host: 'pr-6.app.example.com',
			branchedDatabases: ['data'],
			activate: false,
			restart: undefined,
		});
		const expected = { host: 'pr-6.app.example.com', urlPath: null, isolated: null, branchedDatabases: ['data'] };
		assert.deepStrictEqual(await routingOf(staged.deployment_id), expected);
		assert.deepStrictEqual(rootConfigEntry(project), { host: 'old.app.example.com' }, 'nothing is live yet');

		const activated = await deploy({ project, deployment_id: staged.deployment_id });
		assert.deepStrictEqual(rootConfigEntry(project), { host: 'pr-6.app.example.com', branchedDatabases: ['data'] });
		assert.deepStrictEqual(await routingOf(activated.deployment_id), expected);

		const retried = await deploy({ project, deployment_id: staged.deployment_id });
		assert.notStrictEqual(retried.deployment_id, activated.deployment_id);
		assert.deepStrictEqual(await routingOf(retried.deployment_id), expected);
	});

	it('records on going back to a replaced release the routing it puts back, which list_deployments returns', async () => {
		const project = 'routing-going-back';
		const branched = await deploy({ project, payload, branchedDatabases: ['data'] });
		const shared = await deploy({ project, package: packageIdentifier });
		assert.deepStrictEqual(rootConfigEntry(project), { package: packageIdentifier }, 'off its private copy');

		const back = await deploy({ project, deployment_id: branched.deployment_id });

		assert.deepStrictEqual(rootConfigEntry(project), { branchedDatabases: ['data'] }, 'back on its private copy');
		const branchedRouting = { ...NO_ROUTING, branchedDatabases: ['data'] };
		const { deployments } = await handleListDeployments({ project });
		assert.deepStrictEqual(Object.fromEntries(deployments.map((record) => [record.deployment_id, record.routing])), {
			[branched.deployment_id]: branchedRouting,
			[shared.deployment_id]: NO_ROUTING,
			[back.deployment_id]: branchedRouting,
		});
	});

	it('records the routing of a stage activated while it was still building', async () => {
		const project = 'routing-stage-building';
		const source = path.join(workDirectory, project);
		const started = path.join(workDirectory, `${project}-started`);
		const release = path.join(workDirectory, `${project}-release`);
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: project, version: '1.0.0' }));
		await fs.writeFile(
			path.join(source, 'install.js'),
			`const fs = require('node:fs');\n` +
				`fs.writeFileSync(${JSON.stringify(started)}, '');\n` +
				`const deadline = Date.now() + 30000;\n` +
				`(function wait() {\n` +
				`\tif (fs.existsSync(${JSON.stringify(release)}) || Date.now() > deadline) return;\n` +
				`\tsetTimeout(wait, 10);\n` +
				`})();\n`
		);
		const staging = deploy({
			project,
			payload: (await packageDirectory(source, { skip_node_modules: true })).toString('base64'),
			branchedDatabases: ['data'],
			install_command: 'node install.js',
			activate: false,
			restart: undefined,
		});
		await waitFor(
			() =>
				fs.access(started).then(
					() => true,
					() => false
				),
			30_000
		);
		const [building] = (await handleListDeployments({ project })).deployments;
		const expected = { ...NO_ROUTING, branchedDatabases: ['data'] };
		await waitFor(async () => isDeepStrictEqual(await routingOf(building.deployment_id), expected), {
			timeout: 10_000,
			message: 'the stage records its routing while its install is still running',
		});

		const activating = deploy({ project, deployment_id: building.deployment_id });
		await waitFor(async () => {
			const { deployments } = await handleListDeployments({ project });
			return deployments.some(
				(record) => record.activated_from === building.deployment_id && record.phase === 'prepare'
			);
		}, 30_000);
		await fs.writeFile(release, '');
		await staging;
		const activated = await activating;

		assert.deepStrictEqual(await routingOf(activated.deployment_id), expected);
	});

	it('leaves the routing unknown, rather than none, where no release says what it puts back', async () => {
		const project = 'routing-unknown';
		await assert.rejects(deploy({ project, deployment_id: randomUUID() }));
		const { deployments } = await handleListDeployments({ project, status: 'failed' });
		assert.strictEqual(deployments.length, 1);
		assert.ok(!('routing' in deployments[0]), 'a failed activation of a release this node lacks records no routing');

		const deploymentId = randomUUID();
		await databases.system[SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME].put({
			deployment_id: deploymentId,
			project,
			status: 'success',
		});
		assert.ok(!('routing' in (await handleGetDeployment({ deployment_id: deploymentId }))));
	});
});
