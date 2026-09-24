const assert = require('node:assert');
const { coalesceRefresh } = require('#src/utility/coalesceRefresh');

const drain = () => new Promise((resolve) => setImmediate(resolve));

function gatedRefresh() {
	const runs = [];
	let active = 0;
	let maxActive = 0;
	const refresh = coalesceRefresh(() => {
		active++;
		maxActive = Math.max(maxActive, active);
		const run = Promise.withResolvers();
		runs.push(run);
		return run.promise.finally(() => active--);
	});
	return { refresh, runs, maxActive: () => maxActive };
}

describe('coalesceRefresh', () => {
	it('starts a run when none is in flight', async () => {
		const { refresh, runs } = gatedRefresh();
		const call = refresh();
		await drain();
		assert.strictEqual(runs.length, 1);
		runs[0].resolve();
		await call;
		const next = refresh();
		await drain();
		assert.strictEqual(runs.length, 2, 'a call after the run settled starts a new one');
		runs[1].resolve();
		await next;
	});

	it('runs 50 calls made during a run as one trailing run that starts after it settles', async () => {
		const { refresh, runs, maxActive } = gatedRefresh();
		const inFlight = refresh();
		await drain();
		let resolved = 0;
		const calls = [];
		for (let i = 0; i < 50; i++) {
			calls.push(
				refresh().then(() => {
					resolved++;
					return runs.length;
				})
			);
		}
		await drain();
		assert.strictEqual(runs.length, 1, 'no run starts while one is in flight');
		runs[0].resolve();
		await inFlight;
		await drain();
		assert.strictEqual(runs.length, 2, 'the trailing run starts once the in-flight run settles');
		assert.strictEqual(resolved, 0, 'no caller resolves on the run that was in flight at its call');
		runs[1].resolve();
		assert.deepStrictEqual(await Promise.all(calls), new Array(50).fill(2));
		assert.strictEqual(runs.length, 2);
		assert.strictEqual(maxActive(), 1);
	});

	it('queues exactly one more run for calls made during the trailing run', async () => {
		const { refresh, runs, maxActive } = gatedRefresh();
		const first = refresh();
		const second = refresh();
		await drain();
		runs[0].resolve();
		await first;
		await drain();
		assert.strictEqual(runs.length, 2);
		const third = [refresh(), refresh(), refresh()];
		runs[1].resolve();
		await second;
		await drain();
		assert.strictEqual(runs.length, 3);
		runs[2].resolve();
		await Promise.all(third);
		await drain();
		assert.strictEqual(runs.length, 3);
		assert.strictEqual(maxActive(), 1);
	});

	it('queues a call made from inside a run instead of overlapping it', async () => {
		let runs = 0;
		let active = 0;
		let maxActive = 0;
		let nested;
		const refresh = coalesceRefresh(async () => {
			runs++;
			active++;
			maxActive = Math.max(maxActive, active);
			if (runs === 1) nested = refresh();
			await null;
			active--;
		});
		await refresh();
		await nested;
		assert.strictEqual(runs, 2);
		assert.strictEqual(maxActive, 1);
	});

	it('rejects only the callers of a failed run and still starts the trailing run', async () => {
		const { refresh, runs } = gatedRefresh();
		const failing = refresh();
		const trailing = refresh();
		await drain();
		const error = new Error('scan failed');
		runs[0].reject(error);
		await assert.rejects(failing, error);
		await drain();
		assert.strictEqual(runs.length, 2);
		runs[1].resolve();
		await trailing;
	});

	it('rejects a synchronous throw and stays usable', async () => {
		let calls = 0;
		const error = new Error('thrown before returning a promise');
		const refresh = coalesceRefresh(() => {
			if (++calls === 1) throw error;
			return Promise.resolve();
		});
		await assert.rejects(refresh(), error);
		await refresh();
		assert.strictEqual(calls, 2);
	});
});
