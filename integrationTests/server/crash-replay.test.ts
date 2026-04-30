/**
 * This tests that transaction log replay works on crash. There is a bunch of data written to the system
 * database, so replay needs to work for harper to startup.
 */
import { suite, test, before, after } from 'node:test';
import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';
import { equal } from 'node:assert';

suite('Transaction log replay on crash', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
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
			authorization: ctx.harper.admin,
		});
		equal(response.length, 1);
		equal(response[0].role, 'super_user');
	});
});
