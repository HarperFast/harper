'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');

// Isolate the registry so these checks cannot reset the real runtime's startup hooks.
function run(mode, code) {
	const modulePath = resolve(
		root,
		`${mode === 'compiled' ? 'dist/' : ''}utility/lifecycle.${mode === 'compiled' ? 'js' : 'ts'}`
	);
	const output = execFileSync(
		process.execPath,
		[
			'-e',
			`const assert = require('node:assert/strict');
			const { onStartup, runStartup, resetStartupForTests, hasStarted } = require(${JSON.stringify(modulePath)});
			(async () => { ${code} })().then(() => console.log('completed')).catch(error => { console.error(error); process.exitCode = 1; });`,
		],
		{ encoding: 'utf8', timeout: 30000 }
	);
	assert.equal(output.trim(), 'completed');
}

for (const mode of ['compiled', 'typestrip']) {
	describe(`startup lifecycle (${mode})`, () => {
		it('awaits registered hooks in order and runs them only once', () => {
			run(
				mode,
				`
				const calls = [];
				let release;
				const barrier = new Promise(resolve => { release = resolve; });
				assert.equal(hasStarted(), false);
				onStartup(async () => { calls.push('first'); await barrier; calls.push('finished'); });
				onStartup(() => { calls.push('second'); });
				const startup = runStartup();
				assert.equal(hasStarted(), true);
				assert.equal(runStartup(), startup);
				assert.deepEqual(calls, ['first']);
				release();
				await startup;
				await runStartup();
				assert.deepEqual(calls, ['first', 'finished', 'second']);
			`
			);
		});

		it('resets pending hooks and the cached startup promise', () => {
			run(
				mode,
				`
				const calls = [];
				onStartup(() => { calls.push('discarded'); });
				resetStartupForTests();
				onStartup(() => { calls.push('first'); });
				const first = runStartup();
				await first;
				resetStartupForTests();
				assert.equal(hasStarted(), false);
				onStartup(() => { calls.push('second'); });
				const second = runStartup();
				assert.notEqual(second, first);
				await second;
				assert.deepEqual(calls, ['first', 'second']);
			`
			);
		});

		it('schedules late hooks independently of the completed startup promise', () => {
			run(
				mode,
				`
				await runStartup();
				let release, complete;
				let entered = false, finished = false;
				const barrier = new Promise(resolve => { release = resolve; });
				const completion = new Promise(resolve => { complete = resolve; });
				onStartup(async () => { entered = true; await barrier; finished = true; complete(); });
				assert.equal(entered, false);
				await Promise.resolve();
				assert.equal(entered, true);
				await runStartup();
				assert.equal(finished, false);
				release();
				await completion;
				assert.equal(finished, true);
			`
			);
		});

		it('preserves startup failure and skips subsequent hooks', () => {
			run(
				mode,
				`
				const error = new Error('startup failed');
				let subsequent = false;
				onStartup(() => { throw error; });
				onStartup(() => { subsequent = true; });
				const startup = runStartup();
				await assert.rejects(startup, actual => actual === error);
				assert.equal(runStartup(), startup);
				assert.equal(subsequent, false);
			`
			);
		});
	});
}
