'use strict';

const assert = require('node:assert');
const { prompts, rawPromptsForTesting, promptYesNo } = require('#src/utility/interactivePrompts');

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

describe('promptYesNo', () => {
	let originalInput;

	beforeEach(() => {
		originalInput = rawPromptsForTesting.input;
	});

	afterEach(() => {
		rawPromptsForTesting.input = originalInput;
	});

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

describe('lazy loading', () => {
	it('resolves no @inquirer package just from the seam being loaded, only on a real (unstubbed) call', async () => {
		const { registerHooks } = require('node:module');
		const { PassThrough } = require('node:stream');
		const resolved = [];
		const hook = registerHooks({
			resolve(specifier, context, nextResolve) {
				resolved.push(specifier);
				return nextResolve(specifier, context);
			},
		});
		try {
			// `prompts`/`rawPromptsForTesting` above were already required when this file (and every
			// other file in this run) loaded — so nothing has resolved an @inquirer package by this
			// point proves the seam's own module evaluation never touches them.
			assert.deepStrictEqual(
				resolved.filter((s) => s.startsWith('@inquirer')),
				[],
				'the seam must not have resolved any @inquirer package before a prompt is actually invoked'
			);

			// Fake streams + a pre-aborted signal make @inquirer/core reject immediately, without
			// touching this process's real stdin/TTY, while still exercising the real (unstubbed)
			// lazy loader underneath `rawPromptsForTesting`.
			const fakeOutput = new PassThrough();
			fakeOutput.on('data', () => {});
			const controller = new AbortController();
			controller.abort();
			await rawPromptsForTesting
				.input({ message: 'probe' }, { input: new PassThrough(), output: fakeOutput, signal: controller.signal })
				.catch(() => {});

			assert.ok(resolved.includes('@inquirer/input'), 'invoking the real input prompt must trigger its dynamic import');
		} finally {
			hook.deregister();
		}
	});
});
