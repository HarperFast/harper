'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { deployComponent } = require('#js/components/operations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const {
	preserveRootConfig,
	removeDeployedComponents,
	rootConfigEntry,
	setRootConfigEntry,
} = require('../rootConfigFixture.js');

describe('deploy_component project names (harper#3047)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	removeDeployedComponents();
	let workDirectory;
	let payload;
	let productionDirectory;

	before(async () => {
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-project-name-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'preview', version: '2.0.0' }));
		payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
		productionDirectory = path.join(env.get(CONFIG_PARAMS.COMPONENTSROOT), 'shop');
		await fs.mkdir(productionDirectory, { recursive: true });
		await fs.writeFile(
			path.join(productionDirectory, 'package.json'),
			JSON.stringify({ name: 'shop', version: '1.0.0' })
		);
	});

	after(async () => {
		resetRestartNeeded();
		if (productionDirectory) await fs.rm(productionDirectory, { recursive: true, force: true });
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	for (const [description, request] of [
		['a payload deploy', { payload }],
		['a package deploy', { package: 'file:/nonexistent.tgz' }],
	]) {
		it(`refuses a dotted name on ${description} instead of deploying over the name before the dot`, async () => {
			setRootConfigEntry('shop', { package: 'shop@1.0.0' });
			await assert.rejects(
				deployComponent({ operation: 'deploy_component', project: 'shop.pr-12', restart: false, ...request }),
				(error) => {
					assert.strictEqual(error.statusCode, 400);
					assert.match(error.message, /Project name can only contain alphanumeric, dash and underscores/);
					return true;
				}
			);
			assert.deepStrictEqual(rootConfigEntry('shop'), { package: 'shop@1.0.0' });
			const { version } = JSON.parse(await fs.readFile(path.join(productionDirectory, 'package.json'), 'utf8'));
			assert.strictEqual(version, '1.0.0');
		});
	}
});
