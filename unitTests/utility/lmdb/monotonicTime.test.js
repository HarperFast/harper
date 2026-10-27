'use strict';

const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { getNextMonotonicTime } = require('#src/utility/lmdb/commonUtility');

const COMMON_UTILITY = require.resolve('#src/utility/lmdb/commonUtility');
const CALLS_PER_THREAD = 100_000;

// Waits on a shared start gate so every thread mints at the same moment, then reports its values.
// A `nested` worker spawns a plain child of its own, which inherits the clock from it rather than from main.
const MINTER = `
	const { parentPort, workerData, Worker } = require('node:worker_threads');
	const gate = new Int32Array(workerData.gate);
	function mint() {
		const { getNextMonotonicTime } = require(workerData.commonUtility);
		Atomics.add(gate, 1, 1);
		Atomics.wait(gate, 0, 0);
		const times = new Float64Array(workerData.calls);
		for (let i = 0; i < times.length; i++) times[i] = getNextMonotonicTime();
		return times;
	}
	if (workerData.nested) {
		const child = new Worker(__MINTER__, { eval: true, workerData: { ...workerData, nested: false } });
		child.once('message', (times) => parentPort.postMessage(times));
		child.once('error', (error) => { throw error; });
	} else {
		parentPort.postMessage(mint());
	}
`;
const minterSource = MINTER.replace('__MINTER__', () => JSON.stringify(MINTER));

function assertStrictlyIncreasing(times, label) {
	for (let i = 1; i < times.length; i++) {
		if (!(times[i] > times[i - 1])) assert.fail(`${label}: ${times[i]} at ${i} does not follow ${times[i - 1]}`);
	}
}

describe('getNextMonotonicTime', function () {
	this.timeout(60_000);

	it('never returns the same time on two threads, and increases on each', async function () {
		const gate = new SharedArrayBuffer(8);
		const gateView = new Int32Array(gate);
		const workers = [false, false, false, true].map(
			(nested) =>
				new Worker(minterSource, {
					eval: true,
					workerData: { gate, nested, commonUtility: COMMON_UTILITY, calls: CALLS_PER_THREAD },
				})
		);
		try {
			const results = workers.map(
				(worker) =>
					new Promise((resolve, reject) => {
						worker.once('message', resolve);
						worker.once('error', reject);
						worker.once('exit', (code) => reject(new Error(`minter exited with ${code} before reporting`)));
					})
			);
			const deadline = Date.now() + 30_000;
			while (Atomics.load(gateView, 1) < workers.length) {
				if (Date.now() > deadline) assert.fail('minters did not reach the start gate');
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			Atomics.store(gateView, 0, 1);
			Atomics.notify(gateView, 0);
			const mainTimes = new Float64Array(CALLS_PER_THREAD);
			for (let i = 0; i < mainTimes.length; i++) mainTimes[i] = getNextMonotonicTime();

			const perThread = [mainTimes, ...(await Promise.all(results))];
			const seen = new Set();
			let repeated = 0;
			perThread.forEach((times, thread) => {
				assertStrictlyIncreasing(times, `thread ${thread}`);
				for (const time of times) {
					if (seen.has(time)) repeated++;
					else seen.add(time);
				}
			});
			assert.strictEqual(repeated, 0, `${repeated} of ${seen.size + repeated} times were issued on two threads`);
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	});
});
