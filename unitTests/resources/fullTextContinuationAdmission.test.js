require('../testUtils');
const assert = require('node:assert');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { randomBytes } = require('node:crypto');
const { ServerError } = require('#src/utility/errors/hdbError');
const { startWorker, onMessageByType } = require('#js/server/threads/manageThreads');
const {
	reserveFullTextContinuation,
	confirmFullTextContinuation,
	releaseFullTextContinuation,
	fullTextContinuationDeadline,
	requestFullTextContinuationOwner,
} = require('#src/resources/indexes/fullTextContinuation');
const { waitFor } = require('../waitFor');
const { Worker } = require('node:worker_threads');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

onMessageByType('full-text-admission-test-response', () => {});

function response(worker, action) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => finish(new Error(`Continuation admission worker did not answer: ${action ?? 'ready'}`)),
			10000
		);
		const receive = (event) => {
			if (event.type === 'full-text-admission-test-response') finish(undefined, event.message);
		};
		function finish(error, value) {
			clearTimeout(timer);
			worker.off('message', receive);
			if (error) reject(error);
			else resolve(value);
		}
		worker.on('message', receive);
		if (action)
			worker.postMessage({
				type: 'full-text-admission-test-command',
				message: { originator: 0, ...(typeof action === 'string' ? { operation: action } : action) },
			});
	});
}

async function terminateWorker(worker) {
	if (!worker || worker.threadId < 0) return;
	const exited = once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
	await Promise.all([exited, worker.terminate()]);
}

describe('full-text process-wide continuation admission', () => {
	it('shares capacity across workers and releases claims when the owning worker exits', async () => {
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxCursors: 2 });
		let worker;
		const local = [];
		try {
			worker = startWorker(require.resolve('./fixtures/fullTextContinuationAdmissionWorker.js'), {
				name: 'full-text-admission-test',
				autoRestart: false,
				workerIndex: 0,
				threadCount: 1,
			});
			assert.strictEqual((await response(worker)).ready, true);
			assert.strictEqual((await response(worker, 'reserve')).count, 1);
			local.push(await reserveFullTextContinuation(128, fullTextContinuationDeadline()));
			const denied = await response(worker, 'reserve');
			assert.strictEqual(denied.status, 503);
			assert.match(denied.error, /storage.fullText.maxCursors/);
			await assert.rejects(
				reserveFullTextContinuation(128, fullTextContinuationDeadline()),
				(error) => error.statusCode === 503
			);
			await terminateWorker(worker);
			let reclaimed;
			await waitFor(async () => {
				try {
					reclaimed = await reserveFullTextContinuation(128, fullTextContinuationDeadline());
					return true;
				} catch (error) {
					if (error.statusCode !== 503) throw error;
					return false;
				}
			}, 5000);
			assert(reclaimed);
			local.push(reclaimed);
			await assert.rejects(
				reserveFullTextContinuation(128, fullTextContinuationDeadline()),
				(error) => error.statusCode === 503
			);
		} finally {
			await terminateWorker(worker);
			for (const claim of local) await releaseFullTextContinuation(claim.id);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
		}
	});
	it('routes immutable native snapshot reads, resume, seal and close to another worker', async function () {
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const path = await mkdtemp(join(__dirname, '../envDir/', String(process.pid), 'continuation-worker-'));
		let worker, requester;
		try {
			worker = startWorker(require.resolve('./fixtures/fullTextContinuationAdmissionWorker.js'), {
				name: 'full-text-owner-test',
				autoRestart: false,
				workerIndex: 0,
				threadCount: 1,
			});
			assert.strictEqual((await response(worker)).ready, true);
			const opened = await response(worker, { operation: 'open', path });
			assert(opened.token, opened.error);
			const owner = opened.originator;
			assert.notStrictEqual(owner, 0);
			const queryHash = 'b'.repeat(64);
			const call = (command) =>
				requestFullTextContinuationOwner(owner, { queryHash, ...command }, fullTextContinuationDeadline());
			const resumed = await call({ operation: 'resume', token: opened.token });
			assert.strictEqual(resumed.claim.id, opened.claim.id);
			assert.deepStrictEqual(resumed.position, { batchSize: 7, consumed: 2, boundary: undefined });
			const read = {
				operation: 'read',
				id: resumed.claim.id,
				position: resumed.position,
				responseBytes: opened.responseBytes,
			};
			const original = await call(read);
			assert.strictEqual(original.total, 40);
			assert.strictEqual(original.hits.length, 7);
			requester = startWorker(require.resolve('./fixtures/fullTextContinuationAdmissionWorker.js'), {
				name: 'full-text-requester-test',
				autoRestart: false,
				workerIndex: 1,
				threadCount: 2,
			});
			assert.strictEqual((await response(requester)).ready, true);
			const siblingRead = await response(requester, { operation: 'native', owner, command: { ...read, queryHash } });
			assert.notStrictEqual(siblingRead.originator, owner);
			assert.deepStrictEqual(siblingRead.value, original, siblingRead.error);

			await response(worker, 'update');
			const replay = await call(read);
			assert.deepStrictEqual(replay, original);
			await assert.rejects(
				call({ ...read, responseBytes: 1 }),
				(error) => error.statusCode === 503 && error instanceof ServerError
			);
			await assert.rejects(
				call({ ...read, position: { batchSize: 64, consumed: 41 }, responseBytes: opened.responseBytes * 10 }),
				(error) => error.statusCode === 500
			);
			const token = await call({
				operation: 'seal',
				id: resumed.claim.id,
				position: { ...resumed.position, consumed: 5 },
			});
			assert.strictEqual((await call({ operation: 'resume', token })).position.consumed, 5);
			await assert.rejects(
				call({ operation: 'resume', token, queryHash: 'a'.repeat(64) }),
				(error) => error.statusCode === 410
			);
			await call({ operation: 'close', token });
			await assert.rejects(call(read), (error) => error.statusCode === 410);
			await response(worker, 'shutdown');
			await terminateWorker(worker);
			await assert.rejects(call({ operation: 'resume', token }), (error) => error.statusCode === 410);
		} finally {
			await terminateWorker(requester);
			await terminateWorker(worker);
			await rm(path, { recursive: true, force: true });
		}
	});

	it('answers saturated owner requests immediately instead of dropping their replies', async function () {
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxPendingRequests: 1 });
		const path = await mkdtemp(join(__dirname, '../envDir/', String(process.pid), 'continuation-overload-'));
		let worker;
		try {
			worker = startWorker(require.resolve('./fixtures/fullTextContinuationAdmissionWorker.js'), {
				name: 'full-text-overload-test',
				autoRestart: false,
				workerIndex: 0,
				threadCount: 1,
			});
			await response(worker);
			const opened = await response(worker, { operation: 'open', path });
			assert(opened.claim, opened.error);
			const ids = new Set(Array.from({ length: 128 }, () => randomBytes(16).toString('hex')));
			const replies = await new Promise((resolve, reject) => {
				const received = [];
				const timer = setTimeout(() => finish(new Error(`Owner dropped ${ids.size} replies under load`)), 10000);
				function receive(event) {
					if (event.type !== ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_RESPONSE || !ids.delete(event.message.id)) return;
					received.push(event.message);
					if (!ids.size) finish();
				}
				function finish(error) {
					clearTimeout(timer);
					worker.off('message', receive);
					if (error) reject(error);
					else resolve(received);
				}
				worker.on('message', receive);
				for (const id of ids)
					worker.postMessage({
						type: ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_REQUEST,
						message: {
							id,
							originator: 0,
							deadline: fullTextContinuationDeadline(),
							command: {
								operation: 'read',
								id: opened.claim.id,
								queryHash: 'b'.repeat(64),
								position: { batchSize: 7, consumed: 0 },
								responseBytes: opened.responseBytes,
							},
						},
					});
			});
			assert(
				replies.some((reply) => reply.error?.status === 503 && /maxPendingRequests/.test(reply.error.message)),
				'must exercise actual owner saturation'
			);
			await response(worker, 'shutdown');
		} finally {
			await terminateWorker(worker);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
			await rm(path, { recursive: true, force: true });
		}
	});

	it('bounds retained query bytes independently of cursor count', async () => {
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxCursors: 4, maxRetainedQueryBytes: 256 });
		let claim;
		try {
			claim = await reserveFullTextContinuation(200, fullTextContinuationDeadline());
			await confirmFullTextContinuation(claim.id, fullTextContinuationDeadline());
			await assert.rejects(
				reserveFullTextContinuation(64, fullTextContinuationDeadline()),
				(error) => error.statusCode === 503 && /storage.fullText.maxRetainedQueryBytes/.test(error.message)
			);
			await releaseFullTextContinuation(claim.id);
			claim = await reserveFullTextContinuation(64, fullTextContinuationDeadline());
		} finally {
			if (claim) await releaseFullTextContinuation(claim.id);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
		}
	});

	it('reclaims an unconfirmed reservation when its request deadline passes', async () => {
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxCursors: 1 });
		let replacement;
		try {
			const lost = await reserveFullTextContinuation(128, process.hrtime.bigint() + 100_000_000n);
			await assert.rejects(
				reserveFullTextContinuation(128, fullTextContinuationDeadline()),
				(error) => error.statusCode === 503
			);
			await waitFor(async () => {
				try {
					replacement = await reserveFullTextContinuation(128, fullTextContinuationDeadline());
					return true;
				} catch (error) {
					if (error.statusCode !== 503) throw error;
					return false;
				}
			}, 2000);
			await assert.rejects(
				confirmFullTextContinuation(lost.id, fullTextContinuationDeadline()),
				(error) => error.statusCode === 410
			);
		} finally {
			if (replacement) await releaseFullTextContinuation(replacement.id);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
		}
	});

	it('refuses continuation ownership on unmanaged workers before loading the native addon', async () => {
		const worker = new Worker(require.resolve('./fixtures/fullTextContinuationUnmanagedWorker.js'), {
			workerData: { noServerStart: true },
		});
		try {
			const [error] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) });
			assert.strictEqual(error.statusCode, 503);
			assert.match(error.message, /Harper-managed worker/);
		} finally {
			await terminateWorker(worker);
		}
	});

	it('identifies response reservations that exceed the requesting worker budget', async () => {
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		let worker;
		try {
			worker = startWorker(require.resolve('./fixtures/fullTextContinuationAdmissionWorker.js'), {
				name: 'full-text-byte-limit-test',
				autoRestart: false,
				workerIndex: 0,
				threadCount: 1,
			});
			await response(worker);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxPendingResponseBytes: 1 });
			await assert.rejects(
				requestFullTextContinuationOwner(
					worker.threadId,
					{ operation: 'resume', token: 'unused', queryHash: 'b'.repeat(64) },
					fullTextContinuationDeadline()
				),
				(error) => error.statusCode === 503 && /storage.fullText.maxPendingResponseBytes/.test(error.message)
			);
		} finally {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
			await terminateWorker(worker);
		}
	});
});
