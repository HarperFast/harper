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

	before(() => {
		componentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-modules-'));
		lifecycleMarker = path.join(componentsRoot, 'lifecycle-marker');
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
		fs.rmSync(componentsRoot, { recursive: true, force: true });
	});

	afterEach(() => {
		fs.rmSync(path.join(componentsRoot, 'application', 'node_modules'), { recursive: true, force: true });
		fs.rmSync(lifecycleMarker, { force: true });
	});

	// npm still counts the dependency it would add under --dry-run, so asserting on that count
	// distinguishes a real dry run from npm never running at all
	function assertDryRun(response) {
		assert.equal(response.application.npm_output.added, 1, JSON.stringify(response.application));
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

	it('honors the documented dry_run field', async () => {
		const response = await installModules({ projects: ['application'], dry_run: true });

		assertDryRun(response);
	});

	it('honors a dry_run field that arrives as a string', async () => {
		const response = await installModules({ projects: ['application'], dry_run: 'true' });

		assertDryRun(response);
	});

	it('honors the undocumented camelCase dryRun spelling', async () => {
		const response = await installModules({ projects: ['application'], dryRun: true });

		assertDryRun(response);
	});

	it('installs when dry_run is false', async () => {
		const response = await installModules({ projects: ['application'], dry_run: 'false' });

		assertInstalled(response);
	});

	it('installs when dry_run is omitted', async () => {
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

	it('rejects a request carrying both dry_run spellings', async () => {
		await assert.rejects(installModules({ projects: ['application'], dry_run: true, dryRun: false }), {
			statusCode: 400,
			message: /dryRun/,
		});
		assert.equal(installedDependencyExists(), false);
	});

	it('rejects a request without projects', async () => {
		await assert.rejects(installModules({ dry_run: true }), { statusCode: 400, message: /'projects'/ });
	});

	// the shim is a POSIX shell script; its output and argv files travel as environment values, not as
	// text in the script, so a `$` or a backtick in TMPDIR is never expanded by the shell that runs it
	async function withNpmShim(stdout, callback) {
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-npm-shim-'));
		const originalPath = process.env.PATH;
		try {
			const stdoutPath = path.join(shimDir, 'stdout.txt');
			fs.writeFileSync(stdoutPath, stdout);
			fs.writeFileSync(
				path.join(shimDir, 'npm'),
				'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HARPER_TEST_NPM_ARGV_PATH"\ncat "$HARPER_TEST_NPM_STDOUT_PATH"\n',
				{ mode: 0o755 }
			);
			process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
			process.env.HARPER_TEST_NPM_ARGV_PATH = path.join(shimDir, 'argv.txt');
			process.env.HARPER_TEST_NPM_STDOUT_PATH = stdoutPath;
			return await callback(process.env.HARPER_TEST_NPM_ARGV_PATH);
		} finally {
			process.env.PATH = originalPath;
			delete process.env.HARPER_TEST_NPM_ARGV_PATH;
			delete process.env.HARPER_TEST_NPM_STDOUT_PATH;
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	}

	it('runs npm with the registry audit disabled', async function () {
		if (process.platform === 'win32') return this.skip();
		const argv = await withNpmShim('{"added":0}\n', async (argvPath) => {
			await installModules({ projects: ['application'] });
			return fs.readFileSync(argvPath, 'utf8').split('\n').filter(Boolean);
		});

		assert.deepStrictEqual(argv, ['install', '--force', '--omit=dev', '--no-audit', '--no-fund', '--json']);
	});

	it('parses the JSON report out of the dry-run diff that npm before 11.20 prints ahead of it', async function () {
		if (process.platform === 'win32') return this.skip();
		const cases = [
			['add local-dependency 1.0.0\n{\n  "added": 1\n}\n', { added: 1 }],
			['add local-dependency 1.0.0\r\n{\r\n  "added": 1\r\n}\r\n', { added: 1 }],
			['{\n  "added": 1\n}\n', { added: 1 }],
			['{"from":"a lifecycle script"}\n{\n  "added": 1\n}\n', { added: 1 }],
			['not json\n', 'not json'],
		];
		for (const [stdout, expected] of cases) {
			const response = await withNpmShim(stdout, () => installModules({ projects: ['application'], dry_run: true }));
			assert.deepStrictEqual(response.application.npm_output, expected, JSON.stringify(stdout));
		}
	});
});
