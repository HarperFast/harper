'use strict';

// harper#3061: deploy_component records where it came from on its deployment row.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigPath } = require('#src/config/configUtils');
const { dropComponentDirectory } = require('#src/components/Application');
const { CONFIG_PARAMS, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
const { databases } = require('#src/resources/databases');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { attestedSource } = require('#src/components/deploymentSource');
const { deployComponent } = require('#src/components/operations');
const { preserveRootConfig } = require('../rootConfigFixture.js');

const DEPLOYMENT_TABLE = SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

describe('deploy_component records its source (harper#3061)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	const PROJECT = 'deployment-source-app';
	let source;
	let originalReplicateOperation;
	let replicated;
	let payload;

	before(async () => {
		source = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-source-src-'));
		await fs.writeFile(path.join(source, 'resources.js'), 'export {};\n');
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
		payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
		originalReplicateOperation = server.replication.replicateOperation;
		server.replication.replicateOperation = async (request) => {
			replicated.push({ ...request });
			return { message: '' };
		};
		await testUtils.ensureSystemTables();
	});
	beforeEach(() => (replicated = []));
	after(async () => {
		if (originalReplicateOperation) server.replication.replicateOperation = originalReplicateOperation;
		await dropComponentDirectory(path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), PROJECT), PROJECT).catch(
			() => {}
		);
		resetRestartNeeded();
		if (source) await fs.rm(source, { recursive: true, force: true });
	});

	const recorded = async (deploymentId) => (await databases.system[DEPLOYMENT_TABLE].get(deploymentId)).source;
	const deploy = (extra) =>
		deployComponent({ operation: 'deploy_component', project: PROJECT, payload, restart: false, ...extra });

	it('records what an OIDC exchange attested over anything the request declares', async () => {
		const attested = attestedSource('my-app-prod', { repository: 'HarperFast/my-app', sha: 'a'.repeat(40) });
		const { deployment_id } = await deploy({
			hdb_user: { username: 'ci-deploy', deploySource: attested },
			source: { sha: 'b'.repeat(40) },
		});
		assert.deepStrictEqual(await recorded(deployment_id), attested);
		assert.ok(
			replicated.every((request) => !('source' in request)),
			'peers are not sent what the client declared'
		);
	});

	it('records what a client declared, as declared', async () => {
		const { deployment_id } = await deploy({ hdb_user: { username: 'admin' }, source: { sha: 'b'.repeat(40) } });
		assert.deepStrictEqual(await recorded(deployment_id), { via: 'declared', sha: 'b'.repeat(40) });
	});

	it('records no source when there is none', async () => {
		const { deployment_id } = await deploy({ hdb_user: { username: 'admin' } });
		assert.strictEqual(await recorded(deployment_id), null);
	});
});
