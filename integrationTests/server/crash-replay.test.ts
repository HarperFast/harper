/**
 * This tests that transaction log replay works on crash. There is a bunch of data written to the system
 * database, so replay needs to work for harper to startup.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { setupHarper, teardownHarper, type ContextWithHarper, startHarper } from '../utils/harperLifecycle.ts';
import { equal } from 'node:assert';

suite('Transaction log replay on crash', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx, {
			config: {},
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true, // specifically don't flush, we are testing restart/replay and simulating a crash
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('crash and replay', async () => {
		await new Promise((resolve) => {
			ctx.harper.process.on('exit', resolve);
			ctx.harper.process.kill('SIGKILL'); // violently kill to simulate a crash
		});
		await startHarper(ctx);
		let response = await sendOperation(ctx.harper, {
			operation: 'list_roles',
			authorization: ctx.admin,
		});
		equal(response.length, 1);
		equal(response[0].role, 'super_user');
	});
});

// Should this go in harperLifecycle.ts?
async function sendOperation(config, operation) {
	const response = await fetch(config.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}
