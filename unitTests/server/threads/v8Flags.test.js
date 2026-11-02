'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const HARNESS = path.join(__dirname, 'v8Flags-fixtures', 'harness.cjs');

const HARNESS_TIMEOUT_MS = 30000;

async function runHarness(steps, entry) {
	const args = [HARNESS, JSON.stringify(steps)];
	if (entry) args.push(entry);
	const harness = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
	const deadline = setTimeout(() => harness.kill('SIGKILL'), HARNESS_TIMEOUT_MS);
	try {
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		const [code, signal] = await once(harness, 'close');
		assert.equal(code, 0, `harness exited with ${code ?? signal}: ${output}`);
		return JSON.parse(output.trim().split('\n').at(-1));
	} finally {
		clearTimeout(deadline);
		if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL');
	}
}

describe('threads.v8Flags', function () {
	this.timeout(60000);
	before(function () {
		if (typeof globalThis.Bun !== 'undefined') this.skip();
	});

	it('applies a list of flags before the first worker isolate is created', async () => {
		const {
			results: [result],
		} = await runHarness([['--stack-trace-limit=7', '--max-semi-space-size=1']]);
		assert.deepStrictEqual(result, { stackTraceLimit: 7 });
	});

	it('applies a single string flag', async () => {
		const {
			results: [result],
		} = await runHarness(['--stack-trace-limit=9']);
		assert.deepStrictEqual(result, { stackTraceLimit: 9 });
	});

	it('leaves V8 defaults when unset, null or empty', async () => {
		for (const unset of [null, [], '', ['  ']]) {
			const { defaultStackTraceLimit, results } = await runHarness([unset]);
			assert.deepStrictEqual(results, [{ stackTraceLimit: defaultStackTraceLimit }]);
		}
	});

	it('keeps the first value for the process when the setting changes before a later worker starts', async () => {
		const { results } = await runHarness([['--stack-trace-limit=7'], ['--stack-trace-limit=3']]);
		assert.deepStrictEqual(results, [{ stackTraceLimit: 7 }, { stackTraceLimit: 7 }]);
	});

	it('refuses a value that is not a V8 flag, naming the setting, before applying any entry or starting a worker', async () => {
		const {
			defaultStackTraceLimit,
			results: [refused, afterFix],
		} = await runHarness([['--stack-trace-limit=7', 'optimize-for-size'], null]);
		assert.match(refused.error, /threads\.v8Flags/);
		assert.match(refused.error, /"optimize-for-size"/);
		assert.strictEqual(refused.workerCount, 0);
		assert.deepStrictEqual(afterFix, { stackTraceLimit: defaultStackTraceLimit });
	});

	it('trims surrounding whitespace from an entry', async () => {
		const {
			results: [result],
		} = await runHarness([' --stack-trace-limit=7 ']);
		assert.deepStrictEqual(result, { stackTraceLimit: 7 });
	});

	it('refuses an invalid value at startHTTPThreads entry, before any startup work', async () => {
		const {
			results: [refused],
		} = await runHarness(['optimize-for-size'], 'startHTTPThreads');
		assert.match(refused.error, /threads\.v8Flags.*"optimize-for-size"/);
	});

	it('refuses a non-string entry', async () => {
		const {
			results: [refused],
		} = await runHarness([[7]]);
		assert.match(refused.error, /threads\.v8Flags.*7/);
	});
});
