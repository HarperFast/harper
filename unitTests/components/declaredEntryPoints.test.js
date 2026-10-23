'use strict';

// harper#1719: a deploy warns, before its release goes live, when an entry point its config declares is missing.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { dropComponentDirectory } = require('#src/components/Application');
const { server } = require('#src/server/Server');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { missingEntryPointsWarning } = require('#src/components/declaredEntryPoints');
const { deployComponent } = require('#src/components/operations');
const { ProgressEmitter } = require('#src/server/serverHelpers/progressEmitter');
const { preserveRootConfig } = require('../rootConfigFixture.js');

async function tree(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-points-'));
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
		await fs.writeFile(path.join(dir, name), content);
	}
	return dir;
}

describe('declared entry points (harper#1719)', () => {
	const dirs = [];
	const at = async (files) => {
		const dir = await tree(files);
		dirs.push(dir);
		return dir;
	};
	after(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

	it('says nothing of a tree holding every file its config declares', async () => {
		const dir = await at({
			'config.yaml': "jsResource:\n  files: resources.js\ngraphqlSchema:\n  files: '*.graphql'\n",
			'resources.js': '',
			'schema.graphql': '',
		});
		assert.strictEqual(await missingEntryPointsWarning('web', dir), undefined);
	});

	it('names each declared entry point a tree is missing', async () => {
		const dir = await at({
			'config.yaml':
				"jsResource:\n  files: [resources.js, 'lib/*.js']\ngraphqlSchema:\n  files:\n    source: '/*.graphql'\nrest: true\n",
			'resources.js': '',
		});
		const warning = await missingEntryPointsWarning('web', dir);
		assert.match(warning, /jsResource\.files 'lib\/\*\.js', graphqlSchema\.files '\/\*\.graphql' matched no file/);
		assert.doesNotMatch(warning, /resources\.js'/);
	});

	it("honors a declaration's ignore", async () => {
		const dir = await at({
			'config.yaml': "jsResource:\n  files:\n    source: 'src/*.js'\n    ignore: 'src/skip.js'\n",
			'src/skip.js': '',
		});
		assert.match(await missingEntryPointsWarning('web', dir), /'src\/\*\.js'/);
	});

	it('checks nothing for a tree without a config of its own, or for plugins that are not entry points', async () => {
		assert.strictEqual(await missingEntryPointsWarning('web', await at({ 'index.js': '' })), undefined);
		const staticOnly = await at({ 'config.yaml': "static:\n  files: 'web/**'\nrest: true\n" });
		assert.strictEqual(await missingEntryPointsWarning('web', staticOnly), undefined);
	});

	describe('through deploy_component', function () {
		this.timeout(30_000);
		preserveRootConfig();
		const PROJECT = 'entry-points-app';
		let originalReplicateOperation;
		// deploy_component re-reads the configuration, so it deploys into this run's configured components root.
		const live = () => path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), PROJECT);

		before(() => {
			originalReplicateOperation = server.replication.replicateOperation;
			server.replication.replicateOperation = async () => ({ message: '' });
		});
		after(async () => {
			if (originalReplicateOperation) server.replication.replicateOperation = originalReplicateOperation;
			resetRestartNeeded();
			await dropComponentDirectory(live(), PROJECT).catch(() => {});
		});

		const deploy = async (files, progress) =>
			deployComponent({
				operation: 'deploy_component',
				project: PROJECT,
				restart: false,
				progress,
				payload: (await packageDirectory(await at(files), { skip_node_modules: true })).toString('base64'),
			});
		const CONFIG = 'jsResource:\n  files: resources.js\nrest: true\n';

		it('warns about a release missing its resources, in its response and its progress, and still deploys it', async () => {
			await deploy({ 'config.yaml': CONFIG, 'resources.js': 'export const version = 1;\n' });
			const warnings = [];
			const progress = new ProgressEmitter();
			progress.subscribe(({ event, data }) => event === 'warning' && warnings.push(data.message));
			const response = await deploy({ 'config.yaml': CONFIG }, progress);
			assert.match(
				response.message,
				/missing entry points its config\.yaml declares: jsResource\.files 'resources\.js'/
			);
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /jsResource\.files 'resources\.js' matched no file/);
			await assert.rejects(fs.access(path.join(live(), 'resources.js')), { code: 'ENOENT' });
		});

		it('says nothing when the release carries what its config declares', async () => {
			const response = await deploy({ 'config.yaml': CONFIG, 'resources.js': 'export const version = 2;\n' });
			assert.strictEqual(response.message, `Successfully deployed: ${PROJECT}`);
		});
	});
});
