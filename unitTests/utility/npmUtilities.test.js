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

	afterEach(() => {
		fs.rmSync(path.join(componentsRoot, 'application', 'node_modules'), { recursive: true, force: true });
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
		const response = await installModules({ projects: ['application'] });

		assertInstalled(response);
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

	it('runs npm with the registry audit disabled', async function () {
		if (process.platform === 'win32') return this.skip(); // the shim below is a POSIX shell script
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-npm-shim-'));
		const originalPath = process.env.PATH;
		let argv;
		try {
			const argvPath = path.join(shimDir, 'argv.txt');
			// the destination travels as an environment value, not as text in the script: a `$` or a
			// backtick in TMPDIR would otherwise be expanded by the shell that runs this
			fs.writeFileSync(
				path.join(shimDir, 'npm'),
				'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HARPER_TEST_NPM_ARGV_PATH"\necho \'{"added":0}\'\n',
				{ mode: 0o755 }
			);
			process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
			process.env.HARPER_TEST_NPM_ARGV_PATH = argvPath;
			await installModules({ projects: ['application'] });
			argv = fs.readFileSync(argvPath, 'utf8').split('\n').filter(Boolean);
		} finally {
			process.env.PATH = originalPath;
			delete process.env.HARPER_TEST_NPM_ARGV_PATH;
			fs.rmSync(shimDir, { recursive: true, force: true });
		}

		assert.deepStrictEqual(argv, ['install', '--force', '--omit=dev', '--no-audit', '--no-fund', '--json']);
	});
});
