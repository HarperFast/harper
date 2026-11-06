'use strict';

const assert = require('node:assert');
const {
	closeScopeAfterLoad,
	closeScopeOnShutdown,
	startDeferredScopeCloses,
	whenScopesClosed,
} = require('#src/components/scopeShutdown');

describe('scopeShutdown', () => {
	it('closes at once for a restart SHUTDOWN, and only once connections drain for a process exit', async () => {
		const closed = [];
		closeScopeOnShutdown(async () => void closed.push('restart'), false);
		closeScopeOnShutdown(async () => void closed.push('exit'), true);
		await whenScopesClosed();
		assert.deepEqual(closed, ['restart']);
		startDeferredScopeCloses();
		await whenScopesClosed();
		assert.deepEqual(closed, ['restart', 'exit']);
		startDeferredScopeCloses();
		await whenScopesClosed();
		assert.deepEqual(closed, ['restart', 'exit']);
	});

	it('tracks a close that throws synchronously as settled', async () => {
		closeScopeOnShutdown(() => {
			throw new Error('close failed');
		}, true);
		startDeferredScopeCloses();
		await whenScopesClosed();
	});

	describe('closeScopeAfterLoad', () => {
		it('closes only after the load settles', async function () {
			this.timeout(10_000);
			const events = [];
			let finishLoad;
			const load = new Promise((resolve) => (finishLoad = resolve)).then(() => events.push('loaded'));
			closeScopeOnShutdown(
				() =>
					closeScopeAfterLoad(
						load,
						async () => {
							events.push('closed');
						},
						60_000
					),
				false
			);
			const closing = whenScopesClosed();
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(events, [], 'close must wait while the load is pending');
			finishLoad();
			await closing;
			assert.deepStrictEqual(events, ['loaded', 'closed']);
		});

		it('closes after the bound when the load never settles', async function () {
			this.timeout(10_000);
			const startedAt = Date.now();
			let closed = false;
			const closing = closeScopeAfterLoad(
				new Promise(() => {}),
				async () => {
					closed = true;
				},
				50
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(closed, false, 'fixture guard: still inside the bound');
			await closing;
			assert.strictEqual(closed, true);
			assert.ok(Date.now() - startedAt >= 40, 'the close must not skip the wait');
		});

		it('closes when the load rejects, and surfaces a close failure', async () => {
			let closed = false;
			await closeScopeAfterLoad(
				Promise.reject(new Error('load failed')),
				async () => {
					closed = true;
				},
				60_000
			);
			assert.strictEqual(closed, true);
			await assert.rejects(
				closeScopeAfterLoad(
					Promise.resolve(),
					async () => {
						throw new Error('close failed');
					},
					60_000
				),
				/close failed/
			);
		});

		it('does not wait for a load that already settled', async () => {
			const startedAt = Date.now();
			await closeScopeAfterLoad(Promise.resolve(), async () => {}, 2000);
			assert.ok(Date.now() - startedAt < 1000, 'a settled load must not consume the bound');
		});
	});
});
