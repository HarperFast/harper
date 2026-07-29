'use strict';

const assert = require('node:assert');
const { recordApplicationPreparation } = require('#src/components/Application');

describe('installApplications lock state', () => {
	it('removes a stale successful entry when a required reinstall fails', async () => {
		const applicationConfig = { package: 'test-package' };
		const applicationLock = { applications: { test: applicationConfig } };

		await assert.rejects(
			recordApplicationPreparation(applicationLock, 'test', applicationConfig, async () => {
				throw new Error('installation failed');
			}),
			/installation failed/
		);

		assert.deepStrictEqual(applicationLock.applications, {});
	});
});
