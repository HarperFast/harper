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

describe('install_node_modules', function () {
	this.timeout(60_000); // .mocharc.json sets `timeout: 0`, and these cases spawn real npm

	let componentsRoot;
	let lifecycleMarker;
	let inheritedAuditPolicy;
	let inheritedComponentsRoot;

	before(() => {
		inheritedAuditPolicy = process.env.npm_config_audit;
		process.env.npm_config_audit = 'false';
		componentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-modules-'));
		lifecycleMarker = path.join(componentsRoot, 'lifecycle-marker');
		inheritedComponentsRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, componentsRoot);

		fs.mkdirSync(path.join(componentsRoot, 'dependency'));
		fs.writeFileSync(
			path.join(componentsRoot, 'dependency', 'install.cjs'),
			`require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'ran');\n`
		);
		fs.writeFileSync(
			path.join(componentsRoot, 'dependency', 'package.json'),
			JSON.stringify({
				name: 'local-dependency',
				version: '1.0.0',
				scripts: { install: 'node install.cjs' },
			})
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
		if (inheritedAuditPolicy === undefined) delete process.env.npm_config_audit;
		else process.env.npm_config_audit = inheritedAuditPolicy;
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, inheritedComponentsRoot);
		fs.rmSync(componentsRoot, { recursive: true, force: true });
	});

	afterEach(() => {
		fs.rmSync(path.join(componentsRoot, 'application', 'node_modules'), { recursive: true, force: true });
		fs.rmSync(lifecycleMarker, { force: true });
	});

	// npm still reports the dependency it would add under --dry-run, so asserting on that output
	// distinguishes a real dry run from npm never running at all
	function assertDryRun(response) {
		assert.match(JSON.stringify(response.application.npm_output), /add local-dependency/);
		assert.equal(installedDependencyExists(), false);
	}

	function assertInstalled(response) {
		assert.equal(response.application.npm_output.added, 1, JSON.stringify(response.application));
		assert.equal(installedDependencyExists(), true);
	}

	function installedDependencyExists() {
		return fs.existsSync(path.join(componentsRoot, 'application', 'node_modules', 'local-dependency'));
	}

	async function withNpmLifecycleScriptsEnabled(callback) {
		const inheritedPolicies = Object.entries(process.env).filter(
			([key]) => key.toLowerCase() === 'npm_config_ignore_scripts'
		);
		for (const [key] of inheritedPolicies) delete process.env[key];
		process.env.npm_config_ignore_scripts = 'false';
		try {
			return await callback();
		} finally {
			for (const key of Object.keys(process.env)) {
				if (key.toLowerCase() === 'npm_config_ignore_scripts') delete process.env[key];
			}
			Object.assign(process.env, Object.fromEntries(inheritedPolicies));
		}
	}

	it('honors the legacy camelCase dryRun field', async () => {
		const response = await installModules({ projects: ['application'], dryRun: true });

		assertDryRun(response);
	});

	it('allows lifecycle scripts when the policy is omitted', async () => {
		const response = await withNpmLifecycleScriptsEnabled(() => installModules({ projects: ['application'] }));

		assertInstalled(response);
		assert.equal(fs.existsSync(lifecycleMarker), true);
	});

	it('applies the lifecycle-script policy while preserving the allowed positive control', async () => {
		await withNpmLifecycleScriptsEnabled(async () => {
			const blockedResponse = await installModules({ projects: ['application'], allowInstallScripts: false });

			assertInstalled(blockedResponse);
			assert.equal(fs.existsSync(lifecycleMarker), false);
			fs.rmSync(path.join(componentsRoot, 'application', 'node_modules'), { recursive: true, force: true });

			const allowedResponse = await installModules({ projects: ['application'], allowInstallScripts: true });

			assertInstalled(allowedResponse);
			assert.equal(fs.existsSync(lifecycleMarker), true);
		});
	});

	it('honors install_allow_scripts and rejects both policy spellings together', async () => {
		const response = await withNpmLifecycleScriptsEnabled(() =>
			installModules({ projects: ['application'], install_allow_scripts: false })
		);

		assertInstalled(response);
		assert.equal(fs.existsSync(lifecycleMarker), false);
		await assert.rejects(
			installModules({ projects: ['application'], install_allow_scripts: false, allowInstallScripts: true }),
			{ statusCode: 400, message: /install_allow_scripts/ }
		);
	});

	it('converts a string false policy while accepting operation metadata', async () => {
		const response = await withNpmLifecycleScriptsEnabled(() =>
			installModules({ operation: 'install_node_modules', projects: ['application'], install_allow_scripts: 'false' })
		);

		assertInstalled(response);
		assert.equal(fs.existsSync(lifecycleMarker), false);
	});

	it('rejects an invalid lifecycle-script policy before installation', async () => {
		await assert.rejects(installModules({ projects: ['application'], install_allow_scripts: 'invalid' }), {
			statusCode: 400,
			message: /allowInstallScripts/,
		});
		assert.equal(installedDependencyExists(), false);
	});

	it('rejects a request without projects', async () => {
		await assert.rejects(installModules({ dry_run: true }), { statusCode: 400, message: /'projects'/ });
	});
});
