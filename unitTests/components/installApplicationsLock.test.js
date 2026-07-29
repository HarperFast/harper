'use strict';

const assert = require('node:assert');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const rewire = require('rewire');
const sinon = require('sinon');

const configUtils = require('#src/config/configUtils');

describe('installApplications lock state', () => {
	it('removes a stale successful entry when a required reinstall fails', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'install-applications-lock-'));
		const componentsRoot = join(rootDir, 'components');
		const applicationConfig = { package: 'test-package' };
		const lockPath = join(rootDir, 'harper-application-lock.json');
		await writeFile(lockPath, JSON.stringify({ applications: { test: applicationConfig } }));

		const sandbox = sinon.createSandbox();
		sandbox.stub(configUtils, 'getConfigObj').returns({ test: applicationConfig });
		sandbox.stub(configUtils, 'getConfigPath').returns(componentsRoot);
		sandbox.stub(configUtils, 'getConfigValue').returns(rootDir);
		const applicationModule = rewire('#src/components/Application');
		const restore = applicationModule.__set__({
			getEnvBuiltInComponents: () => [],
			prepareApplication: async (application) => {
				await mkdir(application.dirPath, { recursive: true });
				throw new Error('installation failed');
			},
		});

		try {
			await applicationModule.installApplications();
			const persistedLock = JSON.parse(await readFile(lockPath, 'utf8'));
			assert.deepStrictEqual(persistedLock.applications, {});
		} finally {
			restore();
			sandbox.restore();
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});
