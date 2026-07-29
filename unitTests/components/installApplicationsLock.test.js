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

	it('durably persists the removal before preparation starts, and the success entry only after it fulfills', async () => {
		// A crash between these two persist calls must leave the on-disk lock file showing the
		// component as NOT installed — never still claiming success for a config whose reinstall
		// a subsequent boot would then skip because a partial directory happens to already exist.
		const applicationConfig = { package: 'test-package' };
		const applicationLock = { applications: { test: applicationConfig } };
		const persistedSnapshots = [];
		let prepareCalled = false;

		await recordApplicationPreparation(
			applicationLock,
			'test',
			applicationConfig,
			async () => {
				prepareCalled = true;
				// At the moment preparation runs, the removal must already be durable, not just in memory.
				assert.deepStrictEqual(persistedSnapshots, [{}]);
			},
			async (lock) => {
				persistedSnapshots.push(JSON.parse(JSON.stringify(lock.applications)));
			}
		);

		assert.equal(prepareCalled, true);
		assert.deepStrictEqual(persistedSnapshots, [{}, { test: applicationConfig }]);
	});

	it('does not persist a restored success entry when preparation fails', async () => {
		const applicationConfig = { package: 'test-package' };
		const applicationLock = { applications: { test: applicationConfig } };
		const persistedSnapshots = [];

		await assert.rejects(
			recordApplicationPreparation(
				applicationLock,
				'test',
				applicationConfig,
				async () => {
					throw new Error('installation failed');
				},
				async (lock) => {
					persistedSnapshots.push(JSON.parse(JSON.stringify(lock.applications)));
				}
			),
			/installation failed/
		);

		assert.deepStrictEqual(persistedSnapshots, [{}]);
	});
});
