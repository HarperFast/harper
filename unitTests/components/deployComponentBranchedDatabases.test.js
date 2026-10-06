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
const { preserveRootConfig, rootConfigEntry } = require('../rootConfigFixture.js');

// deployComponentValidator returns undefined when valid and an Error when invalid.
const valid = (res) => res === undefined;

describe('deployComponentValidator branchedDatabases (harper#643)', () => {
	const base = { project: 'myapp', package: 'x' };

	it('accepts an array of database names', () => {
		assert.ok(valid(validator.deployComponentValidator({ ...base, branchedDatabases: ['data'] })));
	});

	it('accepts `true`', () => {
		assert.ok(valid(validator.deployComponentValidator({ ...base, branchedDatabases: true })));
	});

	it('accepts an absent declaration', () => {
		assert.ok(valid(validator.deployComponentValidator(base)));
	});

	it('rejects a shape that is neither an array nor `true`, with the reason from assertBranchedDatabases', () => {
		const error = validator.deployComponentValidator({ ...base, branchedDatabases: 'data' });
		assert.ok(error);
		assert.match(error.message, /expected an array or true/);
	});

	it('rejects branching the system database, with the reason from assertBranchedDatabases', () => {
		const error = validator.deployComponentValidator({ ...base, branchedDatabases: ['system'] });
		assert.ok(error);
		assert.match(error.message, /'system' database cannot be branched/);
	});
});

describe('deploy_component branchedDatabases (harper#3044)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	let workDirectory;
	let payload;
	let tarball;

	before(async () => {
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-branched-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'branched-app', version: '1.0.0' }));
		const packaged = await packageDirectory(source, { skip_node_modules: true });
		payload = packaged.toString('base64');
		tarball = path.join(workDirectory, 'component.tgz');
		await fs.writeFile(tarball, packaged);
	});

	after(async () => {
		// A first deploy of a component asks for a restart, which this process never performs.
		resetRestartNeeded();
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it('refuses it on a payload deploy, which publishes no root-config entry to carry it', async () => {
		const project = 'branched-payload';
		await assert.rejects(
			deployComponent({
				operation: 'deploy_component',
				project,
				payload,
				branchedDatabases: ['data'],
				restart: false,
			}),
			(error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.strictEqual(
					error.message,
					"'branchedDatabases' is only supported for package deployments; set it on the application's root config entry instead"
				);
				return true;
			}
		);
		assert.strictEqual(rootConfigEntry(project), undefined);
	});

	it('refuses it on a peer replaying a payload deploy, as an origin before this check could send one', async () => {
		await assert.rejects(
			deployComponent({
				operation: 'deploy_component',
				project: 'branched-replicated',
				payload,
				branchedDatabases: ['data'],
				restart: false,
				// A replicated execution: the payload stays in the operation when `system` does not replicate.
				_deploymentId: randomUUID(),
			}),
			(error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.match(error.message, /'branchedDatabases' is only supported for package deployments/);
				return true;
			}
		);
	});

	it('publishes it on the root-config entry of a package deploy', async () => {
		const project = 'branched-package';
		const packageIdentifier = `file:${tarball}`;
		const response = await deployComponent({
			operation: 'deploy_component',
			project,
			package: packageIdentifier,
			branchedDatabases: ['data'],
			restart: false,
		});

		assert.strictEqual(response.message, `Successfully deployed: ${project}`);
		assert.deepStrictEqual(rootConfigEntry(project), { package: packageIdentifier, branchedDatabases: ['data'] });
	});
});
