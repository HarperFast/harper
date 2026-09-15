import type input from '@inquirer/input';
import type password from '@inquirer/password';
import type select from '@inquirer/select';
import type confirm from '@inquirer/confirm';

type PromptContext = Parameters<typeof input>[1];
type PromptFn<C, R> = (config: C, context?: PromptContext) => Promise<R>;

// Loads its @inquirer subpath package only on first actual call, not at module evaluation. This
// module sits on the normal server boot path (bin/run.ts -> hdbInfoController -> upgradePrompt ->
// here), so every rolling-restart node was paying to initialize four prompt implementations (and
// @inquirer/core underneath them) it will almost always never call.
function lazyPrompt<C, R>(loadModule: () => Promise<{ default: PromptFn<C, R> }>): PromptFn<C, R> {
	let cached: PromptFn<C, R> | undefined;
	return async (config, context) => {
		cached ??= (await loadModule()).default;
		return cached(config, context);
	};
}

// These are genuine ES modules, so their default exports are non-writable bindings —
// `require('@inquirer/input').default = stub` silently no-ops even after CJS interop, unlike a
// CJS default export's own properties (see the chokidar seam in watcherFallback.ts). Routing every
// call through this plain, mutable object gives unit tests a real seam to stub — a test
// reassignment here is checked before `lazyPrompt`'s own `import()` ever runs, so stubbing never
// triggers the real load either.
const rawPrompts = {
	confirm: lazyPrompt<Parameters<typeof confirm>[0], Awaited<ReturnType<typeof confirm>>>(
		() => import('@inquirer/confirm')
	),
	input: lazyPrompt<Parameters<typeof input>[0], Awaited<ReturnType<typeof input>>>(() => import('@inquirer/input')),
	password: lazyPrompt<Parameters<typeof password>[0], Awaited<ReturnType<typeof password>>>(
		() => import('@inquirer/password')
	),
	select: lazyPrompt<Parameters<typeof select>[0], Awaited<ReturnType<typeof select>>>(
		() => import('@inquirer/select')
	),
};

function isExitPromptError(error: unknown): boolean {
	// Name-only check (no `instanceof @inquirer/core.ExitPromptError`) so detecting a cancel never
	// needs to import @inquirer/core itself — by the time this runs, whichever prompt package was
	// actually called has already pulled core in as its own transitive dependency anyway.
	return error instanceof Error && error.name === 'ExitPromptError';
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
		return guardExitPrompt(rawPrompts.password({ ...config, toggleMask: false }, context), context);
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
