'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const HARNESS = path.join(__dirname, 'v8Flags-fixtures', 'harness.cjs');
const DEFAULT_STACK_TRACE_LIMIT = 10;

// Each element of `steps` is a `threads.v8Flags` value the harness assigns before starting one worker.
async function runHarness(steps) {
	const harness = spawn(process.execPath, [HARNESS, JSON.stringify(steps)], { stdio: ['ignore', 'pipe', 'inherit'] });
	let output = '';
	harness.stdout.on('data', (chunk) => (output += chunk));
	const [code] = await once(harness, 'close');
	assert.equal(code, 0, `harness exited with ${code}: ${output}`);
	return JSON.parse(output.trim().split('\n').at(-1));
}

describe('threads.v8Flags', function () {
	this.timeout(60000);
	before(function () {
		if (typeof globalThis.Bun !== 'undefined') this.skip();
	});

	it('applies a list of flags before the first worker isolate is created', async () => {
		const [result] = await runHarness([['--stack-trace-limit=7', '--max-semi-space-size=1']]);
		assert.deepStrictEqual(result, { stackTraceLimit: 7 });
	});

	it('applies a single string flag', async () => {
		const [result] = await runHarness(['--stack-trace-limit=9']);
		assert.deepStrictEqual(result, { stackTraceLimit: 9 });
	});

	it('leaves V8 defaults when unset, null or empty', async () => {
		for (const unset of [null, []]) {
			const [result] = await runHarness([unset]);
			assert.deepStrictEqual(result, { stackTraceLimit: DEFAULT_STACK_TRACE_LIMIT });
		}
	});

	it('keeps the first value for the process when the setting changes before a later worker starts', async () => {
		const results = await runHarness([['--stack-trace-limit=7'], ['--stack-trace-limit=3']]);
		assert.deepStrictEqual(results, [{ stackTraceLimit: 7 }, { stackTraceLimit: 7 }]);
	});

	it('refuses a value that is not a V8 flag, naming the setting, before applying any entry or starting a worker', async () => {
		const [refused, afterFix] = await runHarness([['--stack-trace-limit=7', 'optimize-for-size'], null]);
		assert.match(refused.error, /threads\.v8Flags/);
		assert.match(refused.error, /"optimize-for-size"/);
		assert.strictEqual(refused.workerCount, 0);
		// The valid entry in the refused list was not applied either.
		assert.deepStrictEqual(afterFix, { stackTraceLimit: DEFAULT_STACK_TRACE_LIMIT });
	});

	it('refuses a non-string entry', async () => {
		const [refused] = await runHarness([[7]]);
		assert.match(refused.error, /threads\.v8Flags.*7/);
	});
});
