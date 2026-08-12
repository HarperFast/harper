'use strict';

const assert = require('node:assert');
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { waitFor } = require('../waitFor.js');
const { Application, prepareApplication } = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');

async function makePayload(rootDir, name, version, installScript) {
	const sourceDir = await mkdtemp(join(rootDir, `${name}-${version}-`));
	await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name, version }));
	await writeFile(join(sourceDir, 'install.js'), installScript);
	return packageDirectory(sourceDir, { skip_node_modules: true });
}

describe('prepareApplication serialization', () => {
	it('compares runtime metadata after recovering an interrupted deploy', async function () {
		this.timeout(10000);
		const rootDir = await mkdtemp(join(tmpdir(), 'prepare-application-recovery-metadata-'));
		const componentDirPath = join(rootDir, 'shared');
		const asidePath = join(rootDir, '.deploy-aside', 'shared', '.in-progress-123-previous');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shared', version: '2.0.0' }));
		await mkdir(asidePath, { recursive: true });
		await writeFile(join(asidePath, 'package.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
		const sourceDir = await mkdtemp(join(rootDir, 'shared-2.0.0-'));
		await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name: 'shared', version: '2.0.0' }));
		const application = new Application({
			name: 'shared',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		application.dirPath = componentDirPath;

		try {
			await prepareApplication(application);
			assert.equal(application.packageMetadataChanged, true);
			assert.equal(JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version, '2.0.0');
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('restores the previous component when installation fails', async function () {
		this.timeout(10000);
		const rootDir = await mkdtemp(join(tmpdir(), 'prepare-application-rollback-'));
		const componentDirPath = join(rootDir, 'shared');
		await mkdir(join(componentDirPath, 'nested'), { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
		await writeFile(join(componentDirPath, 'index.js'), 'module.exports = 1;\n');
		await writeFile(join(componentDirPath, '.env'), 'OLD_ONLY=true\n');
		await writeFile(join(componentDirPath, 'nested', 'old-only.txt'), 'previous bytes\n');
		const failedApplication = new Application({
			name: 'shared',
			payload: await makePayload(rootDir, 'shared', '2.0.0', 'process.exit(2);'),
			install: { command: 'node install.js', timeout: 5000 },
		});
		failedApplication.dirPath = componentDirPath;

		try {
			await assert.rejects(() => prepareApplication(failedApplication), /Failed to install dependencies/);
			assert.equal(JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version, '1.0.0');
			assert.equal(await readFile(join(componentDirPath, 'index.js'), 'utf8'), 'module.exports = 1;\n');
			assert.equal(await readFile(join(componentDirPath, '.env'), 'utf8'), 'OLD_ONLY=true\n');
			assert.equal(await readFile(join(componentDirPath, 'nested', 'old-only.txt'), 'utf8'), 'previous bytes\n');
			await assert.rejects(access(join(rootDir, '.deploy-aside', 'shared')));
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('reports both errors when installation and restoration fail', async function () {
		this.timeout(10000);
		const rootDir = await mkdtemp(join(tmpdir(), 'prepare-application-aggregate-'));
		const componentDirPath = join(rootDir, 'shared');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
		const installScript = `
			const fs = require('node:fs');
			const path = require('node:path');
			const asideDir = path.resolve('..', '.deploy-aside', 'shared');
			const asidePath = path.join(asideDir, fs.readdirSync(asideDir)[0]);
			fs.renameSync(asidePath, path.resolve('..', 'moved-aside'));
			process.exit(2);
		`;
		const application = new Application({
			name: 'shared',
			payload: await makePayload(rootDir, 'shared', '2.0.0', installScript),
			install: { command: 'node install.js', timeout: 5000 },
		});
		application.dirPath = componentDirPath;

		try {
			await assert.rejects(
				() => prepareApplication(application),
				(error) =>
					error instanceof AggregateError &&
					error.errors.length === 2 &&
					error.message.includes('Failed to install dependencies') &&
					error.message.includes('failed to restore its previous component directory') &&
					error.message.includes('ENOENT')
			);
			assert.equal(JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version, '2.0.0');
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('keeps a successful replacement when transient credential cleanup fails', async function () {
		this.timeout(10000);
		const rootDir = await mkdtemp(join(tmpdir(), 'prepare-application-cleanup-'));
		const componentDirPath = join(rootDir, 'shared');
		await mkdir(componentDirPath, { recursive: true });
		await writeFile(join(componentDirPath, 'package.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
		const application = new Application({
			name: 'shared',
			payload: await makePayload(rootDir, 'shared', '2.0.0', 'process.exit(0);'),
			install: { command: 'node install.js', timeout: 5000 },
		});
		application.dirPath = componentDirPath;
		const cleanupError = new Error('credential cleanup failed');
		application.cleanupTransientNpmrc = async () => {
			throw cleanupError;
		};

		try {
			await assert.rejects(
				() => prepareApplication(application),
				(error) => error === cleanupError
			);
			assert.equal(JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version, '2.0.0');
			await assert.rejects(access(join(rootDir, '.deploy-aside', 'shared')));
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it('keeps extraction and installation ordered for the same component directory', async function () {
		this.timeout(10000);
		const rootDir = await mkdtemp(join(tmpdir(), 'prepare-application-serialization-'));
		const componentDirPath = join(rootDir, 'shared');
		const firstStartedPath = join(rootDir, 'first-started');
		const releaseFirstPath = join(rootDir, 'release-first');
		const secondStartedPath = join(rootDir, 'second-started');
		const firstScript = `
			const fs = require('node:fs');
			fs.writeFileSync(${JSON.stringify(firstStartedPath)}, 'started');
			const deadline = Date.now() + 5000;
			(function waitForRelease() {
				if (fs.existsSync(${JSON.stringify(releaseFirstPath)})) process.exit(0);
				if (Date.now() >= deadline) process.exit(2);
				setTimeout(waitForRelease, 10);
			})();
		`;
		const secondScript = `require('node:fs').writeFileSync(${JSON.stringify(secondStartedPath)}, 'started');`;
		const firstApplication = new Application({
			name: 'shared',
			payload: await makePayload(rootDir, 'shared', '1.0.0', firstScript),
			install: { command: 'node install.js', timeout: 5000 },
		});
		const secondApplication = new Application({
			name: 'shared',
			payload: await makePayload(rootDir, 'shared', '2.0.0', secondScript),
			install: { command: 'node install.js', timeout: 5000 },
		});
		firstApplication.dirPath = componentDirPath;
		secondApplication.dirPath = componentDirPath;

		try {
			const firstPreparation = prepareApplication(firstApplication);
			await waitFor(() =>
				access(firstStartedPath).then(
					() => true,
					() => false
				)
			);
			const secondPreparation = prepareApplication(secondApplication);

			await assert.rejects(
				waitFor(
					async () => JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version === '2.0.0',
					{ timeout: 300, message: 'second extraction started before the first install completed' }
				),
				/second extraction started before the first install completed/
			);
			await assert.rejects(access(secondStartedPath));

			await writeFile(releaseFirstPath, 'release');
			await Promise.all([firstPreparation, secondPreparation]);
			assert.equal(JSON.parse(await readFile(join(componentDirPath, 'package.json'), 'utf8')).version, '2.0.0');
			assert.equal(await readFile(secondStartedPath, 'utf8'), 'started');
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});
