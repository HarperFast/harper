const assert = require('node:assert');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const {
	fullTextContinuationNow,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuationClock');
const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');

describe('full-text continuation clock', () => {
	it('keeps limits validation independent of native storage and admission', () => {
		const child = spawnSync(
			process.execPath,
			[
				'-e',
				`
			require('#src/resources/indexes/fullTextSearchLimits').resolveFullTextSearchLimits({ maxCursors: 7 });
			const loaded = Object.keys(require.cache);
			if (loaded.some(path => /rocksdb-js|fullTextContinuation[./]/.test(path))) process.exitCode = 1;
		`,
			],
			{ cwd: require('node:path').resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000 }
		);
		assert.ifError(child.error);
		assert.strictEqual(child.status, 0, child.stderr);
	});

	it('calculates deadlines from an explicit policy', () => {
		const policy = resolveFullTextSearchLimits({ requestBudgetMilliseconds: 1234 });
		const before = fullTextContinuationNow();
		const deadline = fullTextContinuationDeadline(policy);
		const after = fullTextContinuationNow();
		assert(deadline >= before + 1234000000n);
		assert(deadline <= after + 1234000000n);
	});

	it('shares a timeline with workers created at different times', async function () {
		this.timeout(15000);
		for (let n = 0; n < 2; n++) {
			const worker = new Worker(require.resolve('./fixtures/fullTextContinuationClockWorker.js'));
			try {
				await once(worker, 'online', { signal: AbortSignal.timeout(5000) });
				const sample = once(worker, 'message', { signal: AbortSignal.timeout(5000) });
				const before = fullTextContinuationNow();
				worker.postMessage('sample');
				const [value] = await sample;
				const after = fullTextContinuationNow();
				assert(value.now >= before - 1000000n);
				assert(value.now <= after + 1000000n);
				assert(value.deadline >= value.now + 1234000000n);
				assert(value.deadline <= after + 1235000000n);
				assert.strictEqual(value.admissionLoaded, false);
			} finally {
				await worker.terminate();
			}
		}
	});
});
