const assert = require('node:assert');
const { types } = require('node:util');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const env = require('#src/utility/environment/environmentManager');

describe('native lane fixture', () => {
	it('loads source with one environment and propagates it to children', async () => {
		assert(types.isModuleNamespaceObject(env));
		assert(require.resolve('#src/utility/hdbTerms').endsWith('.ts'));
		assert.throws(() => require('#' + 'js/utility/hdbTerms'), { code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' });
		const child = spawnSync(process.execPath, ['-p', "require.resolve('#src/utility/hdbTerms')"], { encoding: 'utf8' });
		assert.strictEqual(child.status, 0, child.stderr);
		assert(child.stdout.trim().endsWith('.ts'));
		const worker = new Worker(
			"require('node:worker_threads').parentPort.postMessage(require.resolve('#src/utility/hdbTerms'))",
			{ eval: true, execArgv: [] }
		);
		try {
			const [file] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
			assert(file.endsWith('.ts'));
		} finally {
			await worker.terminate();
		}
	});
});
