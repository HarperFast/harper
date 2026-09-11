'use strict';

const assert = require('node:assert');
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	Application,
	installApplication,
	packageHasAutomaticInstallWork,
	packageHasProductionInstallWork,
} = require('#src/components/Application');

async function createApplication(root, name, packageJSON, install) {
	const directory = join(root, name);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...packageJSON }));
	const application = new Application({ name, install });
	application.dirPath = directory;
	return application;
}

async function createLifecycleDependency(root, name, markerPath) {
	const dependencyName = `${name}-dependency`;
	const directory = join(root, dependencyName);
	await mkdir(directory);
	await writeFile(
		join(directory, 'install.cjs'),
		`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`
	);
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({ name: dependencyName, version: '1.0.0', scripts: { install: 'node install.cjs' } })
	);
	return { dependencyName, directory };
}

async function configureInstallCapture(application, root, name) {
	const capturePath = join(root, `${name}-args.json`);
	const captureScript = join(root, `${name}-capture.cjs`);
	await writeFile(
		captureScript,
		`require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));\n`
	);
	application.packageManagerPrefix = `"${process.execPath}" "${captureScript}"`;
	return capturePath;
}

describe('automatic application installation', () => {
	beforeEach(async function () {
		this.root = await mkdtemp(join(tmpdir(), 'application-install-'));
	});

	afterEach(async function () {
		await rm(this.root, { recursive: true, force: true });
	});

	it('identifies production dependency and workspace work conservatively', () => {
		for (const manifest of [
			{ dependencies: { runtime: '1' } },
			{ optionalDependencies: { optional: '1' } },
			{ peerDependencies: { peer: '1' } },
			{ workspaces: ['packages/*'] },
			{ workspaces: { packages: ['packages/*'] } },
			{ dependencies: 'invalid' },
			{ workspaces: 'invalid' },
		]) {
			assert.equal(packageHasProductionInstallWork(manifest), true, JSON.stringify(manifest));
		}
		for (const manifest of [
			{},
			{ devDependencies: { build: '1' } },
			{ workspaces: [] },
			{ workspaces: { packages: [] } },
		]) {
			assert.equal(packageHasProductionInstallWork(manifest), false, JSON.stringify(manifest));
		}
		assert.equal(
			packageHasAutomaticInstallWork({ devEngines: { packageManager: { name: 'pnpm' } } }),
			true,
			'an explicit non-npm manager may discover production work outside the root manifest'
		);
	});

	it('skips automatic installation when only development dependencies are declared', async function () {
		const application = await createApplication(this.root, 'development-only', {
			devDependencies: { build: '1.0.0' },
		});
		const capturePath = await configureInstallCapture(application, this.root, 'development-only');

		await installApplication(application);

		await assert.rejects(access(capturePath), (error) => error.code === 'ENOENT');
		assert.equal(application.installationIsOpaque, false);
	});

	it('uses production-only npm flags for the default and declared npm paths', async function () {
		const defaultApplication = await createApplication(this.root, 'default-npm', {
			dependencies: { runtime: '1.0.0' },
		});
		const defaultCapture = await configureInstallCapture(defaultApplication, this.root, 'default-npm');
		await installApplication(defaultApplication);
		assert.deepEqual(JSON.parse(await readFile(defaultCapture, 'utf8')), [
			'npm',
			'install',
			'--force',
			'--omit=dev',
			'--no-audit',
			'--no-fund',
			'--ignore-scripts',
		]);

		const declaredApplication = await createApplication(this.root, 'declared-npm', {
			dependencies: { runtime: '1.0.0' },
			devEngines: { packageManager: { name: 'npm' } },
		});
		const declaredCapture = await configureInstallCapture(declaredApplication, this.root, 'declared-npm');
		await installApplication(declaredApplication);
		assert.deepEqual(JSON.parse(await readFile(declaredCapture, 'utf8')), [
			'npm',
			'install',
			'--omit=dev',
			'--no-audit',
			'--no-fund',
			'--ignore-scripts',
		]);
	});

	it('preserves an explicit non-npm workspace install when the root manifest has no production work', async function () {
		const application = await createApplication(this.root, 'declared-pnpm', {
			devEngines: { packageManager: { name: 'pnpm' } },
		});
		await writeFile(join(application.dirPath, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
		const capturePath = await configureInstallCapture(application, this.root, 'declared-pnpm');

		await installApplication(application);

		assert.deepEqual(JSON.parse(await readFile(capturePath, 'utf8')), ['pnpm', 'install', '--ignore-scripts']);
	});

	it('runs an allowed install lifecycle while still omitting development dependencies', async function () {
		const application = await createApplication(
			this.root,
			'allowed-lifecycle',
			{
				devDependencies: { build: '1.0.0' },
				scripts: { prepare: 'node build.js' },
			},
			{ allowInstallScripts: true }
		);
		const capturePath = await configureInstallCapture(application, this.root, 'allowed-lifecycle');

		await installApplication(application);

		assert.deepEqual(JSON.parse(await readFile(capturePath, 'utf8')), [
			'npm',
			'install',
			'--force',
			'--omit=dev',
			'--no-audit',
			'--no-fund',
		]);
		assert.equal(application.installationIsOpaque, true);
	});

	it('keeps install_command as the development-dependency escape hatch', async function () {
		const application = await createApplication(
			this.root,
			'custom-command',
			{ devDependencies: { build: '1.0.0' } },
			{ command: 'node custom-install.cjs' }
		);
		const automaticCapture = await configureInstallCapture(application, this.root, 'custom-command');
		const customMarker = join(application.dirPath, 'custom-command-ran');
		await writeFile(
			join(application.dirPath, 'custom-install.cjs'),
			`require('node:fs').writeFileSync(${JSON.stringify(customMarker)}, JSON.stringify(process.argv.slice(2)));\n`
		);

		await installApplication(application);

		assert.deepEqual(JSON.parse(await readFile(customMarker, 'utf8')), []);
		await assert.rejects(access(automaticCapture), (error) => error.code === 'ENOENT');
		assert.equal(application.installationIsOpaque, true);
	});

	it('applies the lifecycle-script policy to custom install commands', async function () {
		this.timeout(60_000);
		const inheritedPolicies = Object.entries(process.env).filter(
			([key]) => key.toLowerCase() === 'npm_config_ignore_scripts'
		);
		for (const [key] of inheritedPolicies) delete process.env[key];
		process.env.npm_config_ignore_scripts = 'false';
		try {
			for (const allowInstallScripts of [undefined, false, true]) {
				const name =
					allowInstallScripts === undefined
						? 'custom-scripts-default'
						: allowInstallScripts
							? 'custom-scripts-allowed'
							: 'custom-scripts-blocked';
				const markerPath = join(this.root, `${name}-marker`);
				const dependency = await createLifecycleDependency(this.root, name, markerPath);
				const install = { command: 'npm install --no-audit --no-fund && node -e "process.exit(0)"' };
				if (allowInstallScripts !== undefined) install.allowInstallScripts = allowInstallScripts;
				const application = await createApplication(
					this.root,
					name,
					{ dependencies: { [dependency.dependencyName]: `file:${dependency.directory}` } },
					install
				);
				const warnings = [];
				application.logger.warn = (message) => warnings.push(message);

				await installApplication(application);

				await access(join(application.dirPath, 'node_modules', dependency.dependencyName, 'package.json'));
				assert.equal(
					await access(markerPath).then(
						() => true,
						() => false
					),
					allowInstallScripts === true
				);
				assert.equal(warnings.length, allowInstallScripts === undefined ? 1 : 0);
				if (warnings.length) assert.match(warnings[0], /install\.allowInstallScripts/);
			}
		} finally {
			for (const key of Object.keys(process.env)) {
				if (key.toLowerCase() === 'npm_config_ignore_scripts') delete process.env[key];
			}
			Object.assign(process.env, Object.fromEntries(inheritedPolicies));
		}
	});

	it('materializes runtime dependencies while omitting development dependencies', async function () {
		this.timeout(60_000);
		const runtimeDirectory = join(this.root, 'runtime-package');
		const developmentDirectory = join(this.root, 'development-package');
		await Promise.all([mkdir(runtimeDirectory), mkdir(developmentDirectory)]);
		await Promise.all([
			writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ name: 'runtime-package', version: '1.0.0' })),
			writeFile(
				join(developmentDirectory, 'package.json'),
				JSON.stringify({ name: 'development-package', version: '1.0.0' })
			),
		]);
		const application = await createApplication(this.root, 'real-npm', {
			dependencies: { 'runtime-package': `file:${runtimeDirectory}` },
			devDependencies: { 'development-package': `file:${developmentDirectory}` },
		});
		application.packageManagerPrefix = '';

		await installApplication(application);

		await access(join(application.dirPath, 'node_modules', 'runtime-package', 'package.json'));
		await assert.rejects(
			access(join(application.dirPath, 'node_modules', 'development-package')),
			(error) => error.code === 'ENOENT'
		);
	});
});
