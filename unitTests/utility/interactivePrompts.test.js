'use strict';

const assert = require('node:assert');
const { prompts, rawPromptsForTesting, promptYesNo } = require('#src/utility/interactivePrompts');

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

	let stdoutWrites;

	beforeEach(() => {
		originalInput = rawPromptsForTesting.input;
		originalExit = process.exit;
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		originalStdoutWrite = process.stdout.write;
		exitCode = undefined;
		logged = [];
		stdoutWrites = [];
		process.exit = (code) => {
			exitCode = code;
			throw new Error('process.exit:' + code);
		};
		console.log = (...args) => logged.push(args.join(' '));
		console.error = (...args) => logged.push(args.join(' '));
		process.stdout.write = (chunk) => {
			stdoutWrites.push(chunk);
			return true;
		};
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
		assert.deepStrictEqual(stdoutWrites, ['\n'], 'no ctx was passed, so the newline goes to stdout');
	});

	it('lets a non-cancel rejection propagate unchanged', async () => {
		rawPromptsForTesting.input = async () => {
			throw new Error('validation exploded');
		};

		await assert.rejects(() => prompts.input({ message: 'anything' }), /validation exploded/);
		assert.strictEqual(exitCode, undefined, 'a non-cancel error must not trigger the clean-exit path');
	});

	// `harper login --for-ci | gh secret set --env-file -` (or `> .env`) routes prompts to stderr so
	// the credential block on stdout stays pipeable. A Ctrl-C cancel must not leak a blank line onto
	// stdout in that mode — it has to land on whichever stream the prompt itself was using.
	it('writes the cancel newline to the ctx output stream, not stdout, when the prompt was routed elsewhere', async () => {
		rawPromptsForTesting.input = async () => {
			const error = new Error('User force closed the prompt with SIGINT');
			error.name = 'ExitPromptError';
			throw error;
		};
		const routedWrites = [];
		const routedOutput = {
			write: (chunk) => {
				routedWrites.push(chunk);
				return true;
			},
		};

		await assert.rejects(() => prompts.input({ message: 'anything' }, { output: routedOutput }), /process\.exit:130/);

		assert.strictEqual(exitCode, 130);
		assert.deepStrictEqual(routedWrites, ['\n']);
		assert.deepStrictEqual(stdoutWrites, [], 'the newline must not also (or instead) land on stdout');
	});
});

// @inquirer/confirm's own `getBooleanValue` silently resolves unrecognized input to the configured
// default on Enter — verified by reading node_modules/@inquirer/confirm/dist/index.js: any input
// that doesn't prefix-match "yes"/"no" falls through to `return defaultValue !== false`. That is
// wrong for a gate like GENERATE_CERTS (default yes): a typo must not silently trigger full CA/cert
// regeneration. `promptYesNo` is built on `input` + `validate` instead, whose contract (verified by
// reading node_modules/@inquirer/input/dist/index.js) blocks submission — re-rendering with an error
// and never calling `done()` — until `validate` returns `true`.
describe('promptYesNo', () => {
	let originalInput;

	beforeEach(() => {
		originalInput = rawPromptsForTesting.input;
	});

	afterEach(() => {
		rawPromptsForTesting.input = originalInput;
	});

	// Drives the exact `validate` function promptYesNo hands to `input` against a sequence of
	// candidate answers, mirroring @inquirer/input's own re-ask-until-valid loop: an answer is
	// accepted only once `validate` returns `true`. This proves an unrecognized answer is rejected
	// (would re-ask for real) before a valid one is ever accepted.
	function simulateInputLoop(candidateAnswers) {
		const rejections = [];
		rawPromptsForTesting.input = async (config) => {
			for (const candidate of candidateAnswers) {
				// Real @inquirer/input resolves a bare-Enter (empty) submission against `config.default`
				// before validating — `const answer = value || defaultValue`.
				const resolved = candidate === '' ? String(config.default ?? '') : candidate;
				const result = config.validate ? await config.validate(resolved) : true;
				if (result === true) return resolved;
				rejections.push({ candidate, message: result });
			}
			throw new Error('every candidate answer was rejected by validate');
		};
		return rejections;
	}

	it('re-asks on unrecognized input instead of silently taking the default', async () => {
		const rejections = simulateInputLoop(['sure', 'yes']);

		const answer = await promptYesNo({ message: 'Proceed?', default: true });

		assert.strictEqual(answer, true);
		assert.strictEqual(rejections.length, 1);
		assert.strictEqual(rejections[0].candidate, 'sure');
		assert.match(rejections[0].message, /yes.*no/i);
	});

	it('resolves "yes"/"y" to true and "no"/"n" to false', async () => {
		for (const value of ['yes', 'y', 'YES', 'Y']) {
			simulateInputLoop([value]);
			assert.strictEqual(await promptYesNo({ message: 'Proceed?', default: false }), true, value);
		}
		for (const value of ['no', 'n', 'NO', 'N']) {
			simulateInputLoop([value]);
			assert.strictEqual(await promptYesNo({ message: 'Proceed?', default: true }), false, value);
		}
	});

	it('an empty answer (bare Enter) resolves to the configured default', async () => {
		simulateInputLoop(['']);
		assert.strictEqual(await promptYesNo({ message: 'Proceed?', default: true }), true);

		simulateInputLoop(['']);
		assert.strictEqual(await promptYesNo({ message: 'Proceed?', default: false }), false);
	});
});
