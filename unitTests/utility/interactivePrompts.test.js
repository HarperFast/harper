'use strict';

const assert = require('node:assert');
const { prompts, rawPromptsForTesting } = require('#src/utility/interactivePrompts');

// inquirer@8's own UI re-raised SIGINT itself, so Ctrl-C at a prompt exited the process silently.
// @inquirer/core instead rejects the prompt promise with ExitPromptError, which a call site's
// generic catch (bin/install.ts, dataLayer/hdbInfoController.ts's downgrade confirm) would
// otherwise surface as a logged error plus a stack. `prompts` must restore the old clean-cancel
// exit instead of letting that rejection propagate.
describe('interactivePrompts — Ctrl-C / ExitPromptError handling', () => {
	let originalInput;
	let originalExit;
	let originalConsoleLog;
	let originalConsoleError;
	let originalStdoutWrite;
	let exitCode;
	let logged;

	beforeEach(() => {
		originalInput = rawPromptsForTesting.input;
		originalExit = process.exit;
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		originalStdoutWrite = process.stdout.write;
		exitCode = undefined;
		logged = [];
		process.exit = (code) => {
			exitCode = code;
			throw new Error('process.exit:' + code);
		};
		console.log = (...args) => logged.push(args.join(' '));
		console.error = (...args) => logged.push(args.join(' '));
		process.stdout.write = () => true;
	});

	afterEach(() => {
		rawPromptsForTesting.input = originalInput;
		process.exit = originalExit;
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
		process.stdout.write = originalStdoutWrite;
	});

	it('exits cleanly with code 130 and logs nothing when the underlying prompt rejects with ExitPromptError', async () => {
		rawPromptsForTesting.input = async () => {
			const error = new Error('User force closed the prompt with SIGINT');
			error.name = 'ExitPromptError';
			throw error;
		};

		await assert.rejects(() => prompts.input({ message: 'anything' }), /process\.exit:130/);

		assert.strictEqual(exitCode, 130);
		assert.deepStrictEqual(logged, [], 'ExitPromptError must not be logged like a real failure');
	});

	it('lets a non-cancel rejection propagate unchanged', async () => {
		rawPromptsForTesting.input = async () => {
			throw new Error('validation exploded');
		};

		await assert.rejects(() => prompts.input({ message: 'anything' }), /validation exploded/);
		assert.strictEqual(exitCode, undefined, 'a non-cancel error must not trigger the clean-exit path');
	});
});
