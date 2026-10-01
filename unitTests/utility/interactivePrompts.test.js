'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// A `registerHooks` call made after this file's own top-level `require('#src/utility/interactivePrompts')`
// above can only observe resolutions from that point on — it cannot prove the seam's module
// evaluation itself resolved nothing, since that already happened before the hook existed. A fresh
// child process with the hook registered before the very first `require` closes that gap.
const LAZY_PROBE_SCRIPT = `
'use strict';
const assert = require('node:assert');
const { registerHooks } = require('node:module');
const { PassThrough } = require('node:stream');

const seamPath = process.argv[2];
const resolved = [];
const hook = registerHooks({
	resolve(specifier, context, nextResolve) {
		resolved.push(specifier);
		return nextResolve(specifier, context);
	},
});
const result = { ok: false, steps: {} };

(async () => {
	const seam = require(seamPath);

	result.steps.zeroAtLoad = resolved.filter((s) => s.startsWith('@inquirer'));
	assert.deepStrictEqual(result.steps.zeroAtLoad, [], 'requiring the seam must not resolve any @inquirer package');

	const fakeOutput = new PassThrough();
	fakeOutput.on('data', () => {});
	const controller = new AbortController();
	controller.abort();
	await seam.rawPromptsForTesting
		.input({ message: 'probe' }, { input: new PassThrough(), output: fakeOutput, signal: controller.signal })
		.catch(() => {});

	result.steps.afterCall = resolved.filter((s) => s.startsWith('@inquirer'));
	assert.ok(
		result.steps.afterCall.includes('@inquirer/input'),
		'invoking the real input prompt must trigger its dynamic import'
	);

	result.ok = true;
	process.stdout.write(JSON.stringify(result));
	hook.deregister();
	process.exit(0);
})().catch((error) => {
	result.error = error.message;
	process.stdout.write(JSON.stringify(result));
	hook.deregister();
	process.exit(1);
});
`;

describe('lazy loading', () => {
	it('resolves no @inquirer package from requiring the compiled seam; only a real (unstubbed) call resolves one — verified in a fresh child process', () => {
		const seamPath = path.resolve(__dirname, '../../dist/utility/interactivePrompts.js');
		assert.ok(fs.existsSync(seamPath), `${seamPath} does not exist — run \`npm run build\` first`);

		const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-prompts-lazy-probe-'));
		const scriptPath = path.join(probeDir, 'probe.js');
		fs.writeFileSync(scriptPath, LAZY_PROBE_SCRIPT);

		let output;
		try {
			output = execFileSync(process.execPath, [scriptPath, seamPath], { encoding: 'utf8' });
		} catch (error) {
			assert.fail(`child probe failed: ${error.stdout || error.message}\n${error.stderr || ''}`);
		} finally {
			fs.rmSync(probeDir, { recursive: true, force: true });
		}

		const result = JSON.parse(output);
		assert.strictEqual(result.ok, true, result.error);
		assert.deepStrictEqual(result.steps.zeroAtLoad, []);
		assert.ok(result.steps.afterCall.includes('@inquirer/input'));
	});
});
