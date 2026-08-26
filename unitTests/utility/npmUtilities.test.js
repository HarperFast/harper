'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { installModules } = require('#src/utility/npmUtilities');

describe('install_node_modules', () => {
	let componentsRoot;

	before(() => {
		componentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-modules-'));
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, componentsRoot);

		fs.mkdirSync(path.join(componentsRoot, 'dependency'));
		fs.writeFileSync(
			path.join(componentsRoot, 'dependency', 'package.json'),
			JSON.stringify({ name: 'local-dependency', version: '1.0.0' })
		);
		fs.mkdirSync(path.join(componentsRoot, 'application'));
		fs.writeFileSync(
			path.join(componentsRoot, 'application', 'package.json'),
			JSON.stringify({
				name: 'application',
				version: '1.0.0',
				dependencies: { 'local-dependency': 'file:../dependency' },
			})
		);
	});

	after(() => {
		fs.rmSync(componentsRoot, { recursive: true, force: true });
	});

	it('honors the documented dry_run field', async () => {
		await installModules({ projects: ['application'], dry_run: true });

		assert.equal(fs.existsSync(path.join(componentsRoot, 'application', 'node_modules')), false);
	});
});
