'use strict';

const assert = require('node:assert');
const { access, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
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
