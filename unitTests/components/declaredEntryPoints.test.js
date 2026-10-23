'use strict';

// harper#1719: a deploy fails before its release goes live when an entry point its config declares is missing.

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
const { assertDeclaredEntryPoints } = require('#src/components/declaredEntryPoints');
const { deployComponent } = require('#src/components/operations');
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

	it('accepts a tree holding every file its config declares', async () => {
		const dir = await at({
			'config.yaml': "jsResource:\n  files: resources.js\ngraphqlSchema:\n  files: '*.graphql'\n",
			'resources.js': '',
			'schema.graphql': '',
		});
		await assertDeclaredEntryPoints('web', dir);
	});

	it('refuses a tree missing a declared entry point, naming each', async () => {
		const dir = await at({
			'config.yaml':
				"jsResource:\n  files: [resources.js, 'lib/*.js']\ngraphqlSchema:\n  files:\n    source: '/*.graphql'\nrest: true\n",
			'resources.js': '',
		});
		await assert.rejects(assertDeclaredEntryPoints('web', dir), (error) => {
			assert.strictEqual(error.statusCode, 400);
			assert.match(
				error.message,
				/jsResource\.files 'lib\/\*\.js', graphqlSchema\.files '\/\*\.graphql' matched no file/
			);
			assert.doesNotMatch(error.message, /resources\.js'/);
			return true;
		});
	});

	it("honors a declaration's ignore", async () => {
		const dir = await at({
			'config.yaml': "jsResource:\n  files:\n    source: 'src/*.js'\n    ignore: 'src/skip.js'\n",
			'src/skip.js': '',
		});
		await assert.rejects(assertDeclaredEntryPoints('web', dir), /'src\/\*\.js'/);
	});

	it('checks nothing for a tree without a config of its own, or for plugins that are not entry points', async () => {
		await assertDeclaredEntryPoints('web', await at({ 'index.js': '' }));
		await assertDeclaredEntryPoints('web', await at({ 'config.yaml': "static:\n  files: 'web/**'\nrest: true\n" }));
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
			server.replication.replicateOperation = originalReplicateOperation;
			resetRestartNeeded();
			await dropComponentDirectory(live(), PROJECT).catch(() => {});
		});

		const deploy = async (files) =>
			deployComponent({
				operation: 'deploy_component',
				project: PROJECT,
				restart: false,
				payload: (await packageDirectory(await at(files), { skip_node_modules: true })).toString('base64'),
			});
		const CONFIG = 'jsResource:\n  files: resources.js\nrest: true\n';

		it('fails a release missing its resources and leaves the one it would have replaced serving', async () => {
			await deploy({ 'config.yaml': CONFIG, 'resources.js': 'export const version = 1;\n' });
			await assert.rejects(deploy({ 'config.yaml': CONFIG }), (error) => {
				assert.strictEqual(error.http_resp_msg.phase, 'prepare');
				assert.match(
					error.message,
					/missing entry points its config\.yaml declares: jsResource\.files 'resources\.js'/
				);
				return true;
			});
			assert.strictEqual(await fs.readFile(path.join(live(), 'resources.js'), 'utf8'), 'export const version = 1;\n');
		});
	});
});
