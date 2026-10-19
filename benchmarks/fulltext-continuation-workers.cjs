require('../unitTests/testUtils');
const assert = require('node:assert');
const { once } = require('node:events');
const { toBufferKey } = require('ordered-binary');
const { setupTestDBPath } = require('../unitTests/testUtils');
const { waitFor } = require('../unitTests/waitFor');
const { database } = require('#src/resources/databases');
const { startWorker, onMessageByType } = require('#js/server/threads/manageThreads');
const sizes = (process.env.FT_BENCH_SIZES ?? '10000,50000,100000').split(',').map(Number);
const samples = Number(process.env.FT_BENCH_SAMPLES ?? 20);
const profileOnly = process.env.FT_BENCH_PROFILE === '1';
let requestId = 0;
onMessageByType('fulltext-benchmark-result', () => {});
function command(worker, body) {
	if (worker.threadId < 0) return Promise.reject(new Error('Benchmark worker already exited'));
	const id = ++requestId;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(new Error(`Benchmark worker timed out: ${body?.action ?? 'ready'}`)),
			body?.action === 'seed' ? 120000 : 15000
		);
		const receive = ({ type, message }) => {
			if (type === 'fulltext-benchmark-result' && (body ? message.id === id : message.ready))
				finish(message.error ? new Error(message.error.stack) : undefined, message.value ?? message);
		};
		function finish(error, value) {
			clearTimeout(timeout);
			worker.off('message', receive);
			worker.off('error', failed);
			worker.off('exit', exited);
			if (error) reject(error);
			else resolve(value);
		}
		const failed = (error) => finish(error);
		const exited = (code) => finish(new Error(`Benchmark worker exited: ${code}`));
		worker.on('message', receive);
		worker.once('error', failed);
		worker.once('exit', exited);
		if (body) worker.postMessage({ type: 'fulltext-benchmark-command', message: { originator: 0, id, body } });
	});
}
function stats(values) {
	values.sort((a, b) => a - b);
	return {
		samples: values.length,
		p50: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)],
		p95: values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1))],
		max: values.at(-1),
	};
}
describe('managed-worker continuation measurements', function () {
	this.timeout(600000);
	for (const size of sizes)
		it(`measures same-worker and cross-worker resume on ${size} records`, async () => {
			setupTestDBPath();
			const name = `fulltext-benchmark-${size}-${Date.now()}`;
			database({ database: name });
			const workers = [];
			try {
				const ready = [];
				for (let index = 0; index < 2; index++) {
					const worker = startWorker(require.resolve('./fulltext-continuation-worker.cjs'), {
						name: `fulltext-benchmark-${index}`,
						autoRestart: false,
						workerIndex: index,
						threadCount: 2,
					});
					workers.push(worker);
					ready.push(command(worker));
				}
				await Promise.all(ready);
				for (const worker of workers) await command(worker, { action: 'initialize', database: name });
				const [owner, requester] = workers;
				await command(owner, { action: 'seed', size });
				const query = {
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'lastmarker', waitForIndexMilliseconds: 30000 },
					],
					limit: 1,
					select: ['id', 'title'],
				};
				await waitFor(async () => {
					const result = await command(owner, { query });
					return !result.error && result.records.length === 1;
				}, 120000);
				const rare = Array.from(
					{ length: Math.ceil(size / 500) },
					(_, n) => `p${String(n * 500).padStart(6, '0')}`
				).sort((a, b) =>
					Buffer.compare(
						Buffer.from(toBufferKey(a).toString('base64url')),
						Buffer.from(toBufferKey(b).toString('base64url'))
					)
				);
				for (const comparator of ['matches', 'matches_prefix']) {
					const base = {
						operator: 'and',
						conditions: [
							{
								attribute: 'catalogSearch',
								comparator,
								value: comparator === 'matches' ? 'widget' : 'widg',
								waitForIndexMilliseconds: 30000,
							},
							{ attribute: 'owner', comparator: 'equals', value: 'rare' },
						],
						limit: 5,
						select: ['id', 'title'],
					};
					const first = await command(owner, { query: { ...base, continuation: true } });
					assert(first.continuation, JSON.stringify(first));
					try {
						for (const [route, worker] of [
							['local', owner],
							['remote', requester],
						]) {
							const request = { query: { ...base, continuation: first.continuation } };
							const warm = await command(worker, request);
							assert(!warm.error, JSON.stringify(warm));
							if (profileOnly) {
								await Promise.all(
									workers.map((target, index) => command(target, { action: 'profile-start', main: index === 0 }))
								);
								const result = await command(worker, request);
								assert(!result.error, JSON.stringify(result));
								const counts = await Promise.all(workers.map((target) => command(target, { action: 'profile-stop' })));
								console.log('FT_WORKER_PROFILE ' + JSON.stringify({ size, comparator, route, counts }));
								continue;
							}
							const times = [],
								delays = [];
							for (let n = 0; n < samples; n++) {
								const result = await command(worker, request);
								assert(!result.error, JSON.stringify(result));
								assert.deepStrictEqual(
									result.records.map(({ id }) => id),
									rare.slice(5, 10)
								);
								times.push(result.milliseconds);
								delays.push(result.eventLoopMaxMilliseconds);
							}
							console.log(
								'FT_WORKER_MEASUREMENT ' +
									JSON.stringify({
										size,
										comparator,
										route,
										worker: worker.threadId,
										owner: owner.threadId,
										visibleLimit: 5,
										latencyMilliseconds: stats(times),
										eventLoopDelayMilliseconds: stats(delays),
									})
							);
						}
					} finally {
						await command(owner, { query: { ...base, continuation: first.continuation, closeContinuation: true } });
					}
				}
			} catch (error) {
				console.error('FT_WORKER_FAILURE', error.stack);
				throw error;
			} finally {
				await Promise.all(
					workers.map(async (worker) => {
						if (worker.threadId < 0) return;
						try {
							await command(worker, { action: 'shutdown' });
						} finally {
							const exited = once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
							await Promise.all([exited, worker.terminate()]);
						}
					})
				);
			}
		});
});
