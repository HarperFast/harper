import input from '@inquirer/input';
import password from '@inquirer/password';
import select from '@inquirer/select';
import confirm from '@inquirer/confirm';
import { ExitPromptError } from '@inquirer/core';

// Each prompt type is imported from its own subpath package rather than the `@inquirer/prompts`
// umbrella, which bundles all ten prompt implementations plus `@inquirer/external-editor` (and
// its `chardet`/`iconv-lite`) even though Harper only ever asks for four of them — and this module
// loads on the server boot path (bin/run.ts -> hdbInfoController -> upgradePrompt -> here), not
// just interactive CLI entry points.
//
// These are genuine ES modules, so their named/default exports are non-writable bindings —
// `require('@inquirer/input').default = stub` silently no-ops even after CJS interop, unlike a
// CJS default export's own properties (see the chokidar seam in watcherFallback.ts). Routing every
// call through this plain, mutable object gives unit tests a real seam to stub while production
// code still calls straight through to the real prompts.
const rawPrompts = { confirm, input, password, select };

type PromptContext = Parameters<typeof input>[1];

function isExitPromptError(error: unknown): boolean {
	return error instanceof ExitPromptError || (error instanceof Error && error.name === 'ExitPromptError');
}

async function guardExitPrompt<R>(promise: Promise<R>, context?: PromptContext): Promise<R> {
	try {
		return await promise;
	} catch (error) {
		// inquirer@8's own UI re-raised SIGINT, so Ctrl-C at a prompt exited the process silently.
		// @inquirer/core instead rejects the prompt promise with ExitPromptError, which every call
		// site's generic catch would otherwise surface as a scary logged error and a stack. Exit the
		// same way a SIGINT cancel always has — code 130, no stack — once here rather than in every
		// login/install/upgrade catch block. The newline goes to whichever stream the prompt itself
		// was routed to (`ctx.output`, e.g. stderr for `harper login --for-ci`), never a fixed
		// stdout, so a Ctrl-C during --for-ci doesn't leak a blank line into the piped credentials.
		if (isExitPromptError(error)) {
			(context?.output ?? process.stdout).write('\n');
			process.exit(130);
		}
		throw error;
	}
}

export const prompts = {
	confirm: (...args: Parameters<typeof confirm>) => guardExitPrompt(rawPrompts.confirm(...args), args[1]),
	input: (...args: Parameters<typeof input>) => guardExitPrompt(rawPrompts.input(...args), args[1]),
	password: (...args: Parameters<typeof password>) => {
		const [config, context] = args;
		// toggleMask (default on) lets Ctrl+T echo the plaintext password to the terminal. Harper
		// has no call site that wants that, so it's disabled unconditionally here rather than left
		// as a per-call opt-out.
		return guardExitPrompt(rawPrompts.password({ ...config, toggleMask: false }), context);
	},
	select: (...args: Parameters<typeof select>) => guardExitPrompt(rawPrompts.select(...args), args[1]),
};

// Exposed only so unit tests can stub the implementation underneath the exit-prompt guard above
// (`prompts.input = stub` would replace the guard itself, bypassing the ExitPromptError handling
// this seam exists to cover) — production code never reads this directly.
export const rawPromptsForTesting = rawPrompts;

function isYesNoAnswer(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === 'yes' || v === 'y' || v === 'no' || v === 'n';
}

function yesNoToBoolean(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === 'yes' || v === 'y';
}

/**
 * A yes/no gate that re-asks on anything else, instead of `confirm`'s own behavior: its
 * `getBooleanValue` silently falls through to `config.default` for unrecognized input on Enter,
 * which is wrong for a gate like GENERATE_CERTS (default yes) where a typo must not silently
 * trigger full CA/cert regeneration. Built on `input` + `validate`, which blocks submission until
 * the answer parses as yes/y/no/n — the same validated-loop contract the old `prompt` package gave.
 */
export async function promptYesNo(config: { message: string; default: boolean }, context?: PromptContext) {
	const answer = await prompts.input(
		{
			message: config.message,
			default: config.default ? 'yes' : 'no',
			validate: (value: string) => isYesNoAnswer(value) || "Must respond 'yes' or 'no'.",
		},
		context
	);
	return yesNoToBoolean(answer);
}
