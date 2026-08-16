'use strict';

const assert = require('node:assert');
const path = require('node:path');
const {
	broadcastWithAcknowledgement,
	ITCAcknowledgementError,
	startWorker,
	holdWorkerStartsForSchema,
	releaseWorkerStartsForSchema,
	waitForSchemaWorkerStarts,
} = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'acknowledgement-fixture.js');
const ACCEPT_QUIESCED = (result) => result?.quiesced === true;

describe('broadcastWithAcknowledgement', () => {
	let worker;
	let jobWorker;

	function startTestWorker(name) {
		return new Promise((resolve, reject) => {
			const spawned = startWorker(FIXTURE, {
				name,
				autoRestart: false,
				onStarted(started) {
					started.once('online', () => resolve(spawned));
					started.once('error', reject);
					started.once('exit', (code) => reject(new Error(`Worker exited before online (code ${code})`)));
				},
			});
		});
	}

	beforeEach(async function () {
		this.timeout(30000);
		worker = await startTestWorker('acknowledgement-test');
	});

	afterEach(async () => {
		releaseWorkerStartsForSchema('test-barrier-1');
		releaseWorkerStartsForSchema('test-barrier-2');
		for (const spawned of [worker, jobWorker]) {
			if (!spawned) continue;
			spawned.wasShutdown = true;
			await spawned.terminate();
		}
		worker = undefined;
		jobWorker = undefined;
	});

	it('holds worker starts until every schema barrier is released', async () => {
		holdWorkerStartsForSchema('test-barrier-1');
		holdWorkerStartsForSchema('test-barrier-2');
		let released = false;
		const waiting = waitForSchemaWorkerStarts().then(() => (released = true));
		await new Promise(setImmediate);
		assert.strictEqual(released, false);
		releaseWorkerStartsForSchema('test-barrier-1');
		await new Promise(setImmediate);
		assert.strictEqual(released, false);
		releaseWorkerStartsForSchema('test-barrier-2');
		await waiting;
		assert.strictEqual(released, true);
	});

	it('returns accepted handler results in strict mode', async () => {
		const results = await broadcastWithAcknowledgement(
			{ type: 'acknowledgement-test', action: 'result', result: { quiesced: true } },
			{ timeout: 1000, acceptResult: ACCEPT_QUIESCED }
		);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].status, 'accepted');
		assert.deepStrictEqual(results[0].result, { quiesced: true });
	});

	it('retains a negative handler payload in strict failures', async () => {
		await assert.rejects(
			broadcastWithAcknowledgement(
				{ type: 'acknowledgement-test', action: 'result', result: { quiesced: false, reason: 'busy' } },
				{ timeout: 1000, acceptResult: ACCEPT_QUIESCED }
			),
			(error) => {
				assert.strictEqual(error instanceof ITCAcknowledgementError, true);
				assert.strictEqual(error.results[0].status, 'rejected');
				assert.deepStrictEqual(error.results[0].result, { quiesced: false, reason: 'busy' });
				return true;
			}
		);
	});

	it('distinguishes strict acknowledgement timeouts', async () => {
		await assert.rejects(
			broadcastWithAcknowledgement(
				{ type: 'acknowledgement-test', action: 'timeout' },
				{ timeout: 10, acceptResult: ACCEPT_QUIESCED }
			),
			(error) => {
				assert.strictEqual(error.results[0].status, 'timeout');
				return true;
			}
		);
	});

	it('distinguishes a port closing before acknowledgement', async () => {
		await assert.rejects(
			broadcastWithAcknowledgement(
				{ type: 'acknowledgement-test', action: 'close' },
				{ timeout: 1000, acceptResult: ACCEPT_QUIESCED }
			),
			(error) => {
				assert.strictEqual(error.results[0].status, 'closed');
				return true;
			}
		);
	});

	it('distinguishes synchronous transport failures', async () => {
		await assert.rejects(
			broadcastWithAcknowledgement(
				{ type: 'acknowledgement-test', result: () => {} },
				{ timeout: 1000, acceptResult: ACCEPT_QUIESCED }
			),
			(error) => {
				assert.strictEqual(error.results[0].status, 'transport-error');
				return true;
			}
		);
	});

	it('preserves legacy void resolution without requiring a result', async () => {
		const result = await broadcastWithAcknowledgement({ type: 'acknowledgement-test', action: 'legacy' }, 1000);
		assert.strictEqual(result, undefined);
	});

	it('includes active job workers only when explicitly requested', async () => {
		jobWorker = await startTestWorker('job');
		const message = { type: 'acknowledgement-test', action: 'result', result: { quiesced: true } };
		const defaultResults = await broadcastWithAcknowledgement(message, {
			timeout: 1000,
			acceptResult: ACCEPT_QUIESCED,
		});
		assert.strictEqual(defaultResults.length, 1);
		const ddlResults = await broadcastWithAcknowledgement(message, {
			timeout: 1000,
			acceptResult: ACCEPT_QUIESCED,
			includeJobWorkers: true,
		});
		assert.strictEqual(ddlResults.length, 2);
	});
});
