'use strict';

const assert = require('assert');
const path = require('node:path');
const { startWorker, registerWorkerDataProvider } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'workerData-fixture.js');
// Providers registered here filter on this worker name so they can never leak values into
// workers spawned by other tests sharing the process.
const WORKER_NAME = 'workerData-provider-test';

describe('registerWorkerDataProvider', () => {
	it('rejects reserved workerData keys, duplicate names, and non-function providers', () => {
		assert.throws(() => registerWorkerDataProvider('ticketKeys', () => 1), /already in use/);
		assert.throws(() => registerWorkerDataProvider('addPorts', () => 1), /already in use/);
		// consumed by threadServer.js, not spread by startWorker — must be reserved all the same
		assert.throws(() => registerWorkerDataProvider('noServerStart', () => true), /already in use/);
		const unregister = registerWorkerDataProvider('dupNameTest', () => undefined);
		try {
			assert.throws(() => registerWorkerDataProvider('dupNameTest', () => undefined), /already in use/);
		} finally {
			unregister();
		}
		// after unregistering, the name is free again
		registerWorkerDataProvider('dupNameTest', () => undefined)();
		assert.throws(() => registerWorkerDataProvider('notAFunction', 'value'), /must be a function/);
	});

	it('spreads provider values into workerData; skips undefined, throwing, and non-cloneable providers', async function () {
		this.timeout(30000);
		const unregisters = [
			registerWorkerDataProvider('testProvided', (options) => {
				if (options.name !== WORKER_NAME) return undefined;
				// accessor-backed value: the getter yields once, then throws. The spawn must use the
				// structuredClone result (plain data) — storing the original would re-trigger the
				// getter inside new Worker() and break the spawn.
				let reads = 0;
				return {
					kid: 'k1',
					get secret() {
						if (reads++ > 0) throw new Error('secret may only be read once');
						return 'abc';
					},
				};
			}),
			registerWorkerDataProvider('testSkipped', () => undefined),
			registerWorkerDataProvider('testThrows', (options) => {
				if (options.name === WORKER_NAME) throw new Error('provider boom');
			}),
			// a non-cloneable value must be skipped, not break the spawn
			registerWorkerDataProvider('testNonCloneable', (options) =>
				options.name === WORKER_NAME ? () => {} : undefined
			),
		];
		let worker;
		try {
			const report = await new Promise((resolve, reject) => {
				worker = startWorker(FIXTURE, {
					name: WORKER_NAME,
					autoRestart: false,
					onStarted(spawned) {
						spawned.on('message', (message) => {
							if (message.type === 'workerData-report') resolve(message);
						});
						spawned.once('error', reject);
					},
				});
			});
			assert.deepEqual(report.testProvided, { secret: 'abc', kid: 'k1' });
			assert.equal(report.testSkipped, undefined);
			assert.equal(report.testThrows, undefined);
			assert.equal(report.testNonCloneable, undefined);
			// built-ins are untouched
			assert.equal(report.name, WORKER_NAME);
			assert.equal(report.hasTicketKeys, true);
		} finally {
			for (const unregister of unregisters) unregister();
			if (worker) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});

	it('passes the startWorker options to providers so they can filter by worker type', async function () {
		this.timeout(30000);
		const seen = [];
		const unregister = registerWorkerDataProvider('testProvided', (options) => {
			if (options.name !== WORKER_NAME) return undefined;
			seen.push(options.name);
			return undefined; // filter decision only — supply nothing
		});
		let worker;
		try {
			const report = await new Promise((resolve, reject) => {
				worker = startWorker(FIXTURE, {
					name: WORKER_NAME,
					autoRestart: false,
					onStarted(spawned) {
						spawned.on('message', (message) => {
							if (message.type === 'workerData-report') resolve(message);
						});
						spawned.once('error', reject);
					},
				});
			});
			assert.deepEqual(seen, [WORKER_NAME]);
			assert.equal(report.testProvided, undefined);
		} finally {
			unregister();
			if (worker) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});
});
