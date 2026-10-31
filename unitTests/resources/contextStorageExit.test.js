require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { contextStorage } = require('#src/resources/transaction');

describe('contextStorage.exit', function () {
	this.timeout(5000);
	const request = { authorize: true };

	it('leaves the request context even after a nested run', () => {
		contextStorage.run(request, () => {
			contextStorage.exit(() => {
				assert.strictEqual(contextStorage.getStore(), undefined);
				const inner = {};
				contextStorage.run(inner, () => assert.strictEqual(contextStorage.getStore(), inner));
				assert.strictEqual(contextStorage.getStore(), undefined, 'the nested run must not restore the request');
			});
			assert.strictEqual(contextStorage.getStore(), request, "the caller's context is restored");
		});
	});

	it('keeps async work started inside it out of the request context', async () => {
		const observed = await contextStorage.run(request, () =>
			contextStorage.exit(async () => {
				contextStorage.run({}, () => {});
				const timer = new Promise((resolve) => setTimeout(() => resolve(contextStorage.getStore()), 1));
				await delay(1);
				const afterAwait = contextStorage.getStore();
				contextStorage.run({}, () => {});
				return { afterAwait, afterSecondRun: contextStorage.getStore(), timer: await timer };
			})
		);
		assert.deepStrictEqual(observed, { afterAwait: undefined, afterSecondRun: undefined, timer: undefined });
	});

	it('forwards arguments, returns the result and restores the caller after a throw or rejection', async () => {
		contextStorage.run(request, () => {
			assert.strictEqual(
				contextStorage.exit((a, b) => a + b, 1, 2),
				3
			);
			assert.throws(() =>
				contextStorage.exit(() => {
					throw new Error('thrown');
				})
			);
			assert.strictEqual(contextStorage.getStore(), request);
		});
		await contextStorage.run(request, async () => {
			await assert.rejects(contextStorage.exit(async () => Promise.reject(new Error('rejected'))));
			assert.strictEqual(contextStorage.getStore(), request);
		});
	});
});
