require('../testUtils');
const assert = require('node:assert');
const { once } = require('node:events');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { startWorker, onMessageByType } = require('#js/server/threads/manageThreads');
const {
	reserveFullTextContinuation,
	confirmFullTextContinuation,
	releaseFullTextContinuation,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuation');
const { waitFor } = require('../waitFor');

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
			worker.postMessage({ type: 'full-text-admission-test-command', message: { originator: 0, operation: action } });
	});
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
			await assert.rejects(
				reserveFullTextContinuation(128, fullTextContinuationDeadline()),
				(error) => error.statusCode === 503
			);
			const exited = once(worker, 'exit');
			await worker.terminate();
			await exited;
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
			if (worker) await worker.terminate();
			for (const claim of local) await releaseFullTextContinuation(claim.id);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
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
				(error) => error.statusCode === 503
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
});
