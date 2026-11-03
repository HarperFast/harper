'use strict';

const assert = require('node:assert');
const { closeScopeOnShutdown, startDeferredScopeCloses, whenScopesClosed } = require('#src/components/scopeShutdown');

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
});
