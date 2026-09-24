'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	getStartupInstallTimeoutMs,
	recordApplicationPreparation,
	trackStartupPreparation,
	updateApplicationLock,
	waitForStartupPreparations,
} = require('#src/components/Application');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const harperLogger =
	require('#src/utility/logging/harper_logger').default || require('#src/utility/logging/harper_logger');

function memoryLock(applications) {
	const snapshots = [];
	const updateLock = async (mutate) => {
		mutate(applications);
		snapshots.push(JSON.parse(JSON.stringify(applications)));
	};
	return { applications, snapshots, updateLock };
}

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let nameSequence = 0;
// Tracked preparations are process-wide, so no test may reuse another's name.
function uniqueName(label) {
	return `startup-prep-${label}-${process.pid}-${++nameSequence}`;
}

function track(label, start, onLateSuccess = () => {}, configKey = 'config') {
	const application = { dirPath: '/nonexistent', isNewComponent: true, packageMetadataChanged: false };
	return trackStartupPreparation(uniqueName(label), configKey, application, start, onLateSuccess);
}

async function withTimerSpy(delays, run) {
	const originals = {
		setTimeout: global.setTimeout,
		setInterval: global.setInterval,
		clearTimeout: global.clearTimeout,
		clearInterval: global.clearInterval,
	};
	const armed = [];
	const uncleared = new Set();
	const spy = (original) =>
		function (callback, delay, ...rest) {
			const handle = original(callback, delay, ...rest);
			if (delays.includes(delay)) {
				armed.push(delay);
				uncleared.add(handle);
			}
			return handle;
		};
	global.setTimeout = spy(originals.setTimeout);
	global.setInterval = spy(originals.setInterval);
	global.clearTimeout = (handle) => {
		uncleared.delete(handle);
		return originals.clearTimeout(handle);
	};
	global.clearInterval = (handle) => {
		uncleared.delete(handle);
		return originals.clearInterval(handle);
	};
	try {
		await run(originals);
	} finally {
		Object.assign(global, originals);
	}
	return { armed, uncleared };
}

async function collectUnhandledRejections(run) {
	const rejections = [];
	const listener = (reason) => rejections.push(reason);
	process.on('unhandledRejection', listener);
	try {
		await run();
		await sleep(20);
	} finally {
		process.off('unhandledRejection', listener);
	}
	return rejections;
}

describe('installApplications lock state', () => {
	it('removes a stale successful entry when a required reinstall fails', async () => {
		const applicationConfig = { package: 'test-package' };
		const lock = memoryLock({ test: applicationConfig });

		await assert.rejects(
			recordApplicationPreparation(
				'test',
				applicationConfig,
				async () => {
					throw new Error('installation failed');
				},
				lock.updateLock
			),
			/installation failed/
		);

		assert.deepStrictEqual(lock.applications, {});
	});

	it('durably persists the removal before preparation starts, and the success entry only after it fulfills', async () => {
		// A crash between these two transitions must leave the on-disk lock file showing the component as
		// NOT installed — never still claiming success for a config whose reinstall a subsequent boot would
		// then skip because a partial directory happens to already exist.
		const applicationConfig = { package: 'test-package' };
		const lock = memoryLock({ test: applicationConfig });
		let prepareCalled = false;

		await recordApplicationPreparation(
			'test',
			applicationConfig,
			async () => {
				prepareCalled = true;
				assert.deepStrictEqual(lock.snapshots, [{}]);
			},
			lock.updateLock
		);

		assert.equal(prepareCalled, true);
		assert.deepStrictEqual(lock.snapshots, [{}, { test: applicationConfig }]);
	});

	it('does not persist a restored success entry when preparation fails', async () => {
		const applicationConfig = { package: 'test-package' };
		const lock = memoryLock({ test: applicationConfig });

		await assert.rejects(
			recordApplicationPreparation(
				'test',
				applicationConfig,
				async () => {
					throw new Error('installation failed');
				},
				lock.updateLock
			),
			/installation failed/
		);

		assert.deepStrictEqual(lock.snapshots, [{}]);
	});

	describe('updateApplicationLock', () => {
		let root;
		beforeEach(async () => {
			root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-lock-'));
		});
		afterEach(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		it('applies a preparation that outlives its installApplications call on top of what a later call recorded', async () => {
			const lockPath = path.join(root, 'harper-application-lock.json');
			await fs.writeFile(lockPath, JSON.stringify({ applications: { stalled: { package: 'a' } } }));
			const readLock = async () => JSON.parse(await fs.readFile(lockPath, 'utf8')).applications;

			const started = deferred();
			const release = deferred();
			const stalled = recordApplicationPreparation(
				'stalled',
				{ package: 'a' },
				() => {
					started.resolve();
					return release.promise;
				},
				(mutate) => updateApplicationLock(lockPath, mutate)
			);
			await started.promise;
			assert.deepStrictEqual(await readLock(), {});

			await recordApplicationPreparation(
				'other',
				{ package: 'b' },
				async () => {},
				(mutate) => updateApplicationLock(lockPath, mutate)
			);
			assert.deepStrictEqual(await readLock(), { other: { package: 'b' } });

			release.resolve();
			await stalled;
			assert.deepStrictEqual(await readLock(), { other: { package: 'b' }, stalled: { package: 'a' } });
		});

		it('creates the file from an empty lock when it does not exist', async () => {
			const lockPath = path.join(root, 'harper-application-lock.json');
			await updateApplicationLock(lockPath, () => {});
			assert.deepStrictEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), { applications: {} });
		});
	});
});

describe('startup preparation wait', () => {
	describe('getStartupInstallTimeoutMs', () => {
		afterEach(() => env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, undefined));

		it('defaults to ten minutes when unset, blank, or not a finite non-negative number', () => {
			for (const value of [undefined, null, '', '   ', true, false, [], {}, 'ten', NaN, Infinity, -1, '-3']) {
				env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, value);
				assert.strictEqual(getStartupInstallTimeoutMs(), 600000, `for ${JSON.stringify(value)}`);
			}
		});

		it('accepts a number or numeric string, and 0 (wait indefinitely)', () => {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, 2500);
			assert.strictEqual(getStartupInstallTimeoutMs(), 2500);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, '30000');
			assert.strictEqual(getStartupInstallTimeoutMs(), 30000);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, 0);
			assert.strictEqual(getStartupInstallTimeoutMs(), 0);
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STARTUPINSTALLTIMEOUT, '0');
			assert.strictEqual(getStartupInstallTimeoutMs(), 0);
		});
	});

	describe('waitForStartupPreparations', () => {
		it('returns only the preparations still pending at the deadline, and marks them left behind', async () => {
			const done = track('done', async () => {});
			const failed = track('failed', () => Promise.reject(new Error('install failed')));
			const stalled = deferred();
			const pending = track('pending', () => stalled.promise);

			const startedAt = performance.now();
			const leftBehind = await waitForStartupPreparations([done, failed, pending], 50);

			assert.ok(performance.now() - startedAt >= 45, 'waited for the deadline');
			assert.deepStrictEqual(leftBehind, [pending]);
			assert.deepStrictEqual([done.leftBehind, failed.leftBehind, pending.leftBehind], [false, false, true]);
			stalled.resolve();
			await pending.promise;
		});

		it('returns as soon as everything settles and clears its deadline and progress timers', async () => {
			const release = deferred();
			const preparation = track('fast', () => release.promise);
			let leftBehind;
			let elapsed;
			const { armed, uncleared } = await withTimerSpy([54_321, 12_345], async (originals) => {
				originals.setTimeout(release.resolve, 10);
				const startedAt = performance.now();
				leftBehind = await waitForStartupPreparations([preparation], 54_321, 12_345);
				elapsed = performance.now() - startedAt;
			});

			assert.deepStrictEqual(leftBehind, []);
			assert.ok(elapsed < 5_000, 'did not wait for the deadline');
			assert.deepStrictEqual(armed.sort(), [12_345, 54_321]);
			assert.strictEqual(uncleared.size, 0, 'deadline and progress timers are cleared');
		});

		it('arms nothing when there is nothing to wait for', async () => {
			const { armed } = await withTimerSpy([54_321, 12_345], async () => {
				assert.deepStrictEqual(await waitForStartupPreparations([], 54_321, 12_345), []);
			});
			assert.deepStrictEqual(armed, []);
		});

		it('waits indefinitely for Infinity', async () => {
			const release = deferred();
			const preparation = track('unbounded', () => release.promise);
			let returned = false;
			const waiting = waitForStartupPreparations([preparation], Infinity).then((leftBehind) => {
				returned = true;
				return leftBehind;
			});
			await sleep(50);
			assert.strictEqual(returned, false);
			release.resolve();
			assert.deepStrictEqual(await waiting, []);
		});

		it('clamps a deadline beyond the setTimeout ceiling instead of firing immediately', async () => {
			const release = deferred();
			const preparation = track('huge', () => release.promise);
			let returned = false;
			const waiting = waitForStartupPreparations([preparation], 30 * 24 * 60 * 60 * 1000).then(() => (returned = true));
			await sleep(50);
			assert.strictEqual(returned, false, 'a >2^31 ms delay would otherwise fire after 1 ms');
			release.resolve();
			await waiting;
		});

		it('warns with the names startup is still waiting for', async () => {
			const warnings = [];
			const originalWarn = harperLogger.warn;
			harperLogger.warn = (message) => warnings.push(message);
			try {
				const stalled = deferred();
				const pending = track('reported', () => stalled.promise);
				await waitForStartupPreparations([pending], 80, 20);
				stalled.resolve();
				assert.ok(warnings.length > 0, 'progress was reported');
				assert.match(warnings[0], new RegExp(`still waiting for component preparation.*${pending.name}`));
			} finally {
				harperLogger.warn = originalWarn;
			}
		});

		it('a preparation that rejects after the deadline is not an unhandled rejection', async () => {
			const rejections = await collectUnhandledRejections(async () => {
				const stalled = deferred();
				const pending = track('late-failure', () => stalled.promise);
				await waitForStartupPreparations([pending], 10);
				stalled.reject(new Error('install failed late'));
			});
			assert.deepStrictEqual(rejections, []);
		});
	});

	describe('trackStartupPreparation', () => {
		it('reuses the in-flight preparation for the same component and configuration', async () => {
			const release = deferred();
			let starts = 0;
			const start = () => {
				starts++;
				return release.promise;
			};
			const name = uniqueName('dedupe');
			const application = { dirPath: '/nonexistent', isNewComponent: true, packageMetadataChanged: false };
			const first = trackStartupPreparation(name, 'config', application, start, () => {});
			const second = trackStartupPreparation(name, 'config', application, start, () => {});
			assert.strictEqual(second, first);
			assert.strictEqual(starts, 1);

			release.resolve();
			await first.promise;
			await sleep(0);
			const afterSettle = trackStartupPreparation(
				name,
				'config',
				application,
				async () => {},
				() => {}
			);
			assert.notStrictEqual(afterSettle, first, 'a settled preparation is not reused');
		});

		it('starts a new preparation when the configuration changed, and rejoins the first when it changes back', () => {
			const name = uniqueName('reconfigured');
			const application = { dirPath: '/nonexistent', isNewComponent: true, packageMetadataChanged: false };
			let starts = 0;
			const start = () => {
				starts++;
				return new Promise(() => {});
			};
			const configA = trackStartupPreparation(name, 'A', application, start, () => {});
			const configB = trackStartupPreparation(name, 'B', application, start, () => {});
			const configAAgain = trackStartupPreparation(name, 'A', application, start, () => {});
			assert.notStrictEqual(configB, configA);
			assert.strictEqual(configAAgain, configA);
			assert.strictEqual(starts, 2);
		});

		it('reports the success of a preparation startup stopped waiting for, and only that', async () => {
			const late = [];
			const onLateSuccess = (preparation) => late.push(preparation.name);

			const inTimeRelease = deferred();
			const inTime = track('in-time', () => inTimeRelease.promise, onLateSuccess);
			const waiting = waitForStartupPreparations([inTime], 60_000);
			inTimeRelease.resolve();
			await waiting;

			const abandonedRelease = deferred();
			const abandoned = track('abandoned', () => abandonedRelease.promise, onLateSuccess);
			await waitForStartupPreparations([abandoned], 10);
			abandonedRelease.resolve();
			await abandoned.promise;
			await sleep(0);

			assert.deepStrictEqual(late, [abandoned.name]);
		});

		it('still reports a left-behind preparation that a later call waits on and sees finish', async () => {
			// That later call cannot know its own generation will load the component on every worker.
			const late = [];
			const release = deferred();
			const name = uniqueName('picked-up');
			const application = { dirPath: '/nonexistent', isNewComponent: true, packageMetadataChanged: false };
			const start = () => release.promise;
			const onLateSuccess = (preparation) => late.push(preparation.name);

			const boot = trackStartupPreparation(name, 'config', application, start, onLateSuccess);
			await waitForStartupPreparations([boot], 10);
			const restart = trackStartupPreparation(name, 'config', application, start, onLateSuccess);
			assert.strictEqual(restart, boot);
			const waiting = waitForStartupPreparations([restart], 60_000);
			release.resolve();
			assert.deepStrictEqual(await waiting, []);
			await sleep(0);

			assert.deepStrictEqual(late, [name]);
		});

		it('never reports a failure as late, and a throwing reporter is not an unhandled rejection', async () => {
			let reported = 0;
			const rejections = await collectUnhandledRejections(async () => {
				const failing = deferred();
				const failed = track(
					'late-reject',
					() => failing.promise,
					() => {
						reported++;
					}
				);
				await waitForStartupPreparations([failed], 10);
				failing.reject(new Error('install failed'));

				const succeeding = deferred();
				const thrower = track(
					'throwing-reporter',
					() => succeeding.promise,
					() => {
						reported++;
						throw new Error('status store closed');
					}
				);
				await waitForStartupPreparations([thrower], 10);
				succeeding.resolve();
			});
			assert.strictEqual(reported, 1);
			assert.deepStrictEqual(rejections, []);
		});
	});
});
