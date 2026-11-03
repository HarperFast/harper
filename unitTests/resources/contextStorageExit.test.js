require('../testUtils');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
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

	it('leaves the request context under the async_hooks storage, whatever the runtime', function () {
		this.timeout(30_000);
		// Node 22 always uses the async_hooks storage; Node 24+ only with this flag
		const flags = process.allowedNodeEnvironmentFlags.has('--no-async-context-frame')
			? ['--no-async-context-frame']
			: [];
		const script = `const { contextStorage } = require(process.argv[1]);
			const store = contextStorage.run({}, () => contextStorage.exit(() => {
				contextStorage.run({}, () => {});
				return contextStorage.getStore();
			}));
			process.stdout.write('store=' + String(store));`;
		const child = spawnSync(process.execPath, [...flags, '-e', script, require.resolve('#src/resources/transaction')], {
			encoding: 'utf8',
			timeout: 25_000,
		});
		assert.ifError(child.error);
		assert.strictEqual(child.status, 0, child.stderr);
		assert.match(child.stdout, /store=undefined$/);
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
