import { confirm, input, password, select } from '@inquirer/prompts';
import { ExitPromptError } from '@inquirer/core';

// `@inquirer/prompts` is a genuine ES module, so its named exports are non-writable bindings —
// `require('@inquirer/prompts').input = stub` silently no-ops even after CJS interop, unlike a
// CJS default export's own properties (see the chokidar seam in watcherFallback.ts). Routing every
// call through this plain, mutable object gives unit tests a real seam to stub while production
// code still calls straight through to the real prompts.
const rawPrompts = { confirm, input, password, select };

function isExitPromptError(error: unknown): boolean {
	return error instanceof ExitPromptError || (error instanceof Error && error.name === 'ExitPromptError');
}

async function guardExitPrompt<R>(promise: Promise<R>): Promise<R> {
	try {
		return await promise;
	} catch (error) {
		// inquirer@8's own UI re-raised SIGINT, so Ctrl-C at a prompt exited the process silently.
		// @inquirer/core instead rejects the prompt promise with ExitPromptError, which every call
		// site's generic catch would otherwise surface as a scary logged error and a stack. Exit the
		// same way a SIGINT cancel always has — code 130, no stack — once here rather than in every
		// login/install/upgrade catch block.
		if (isExitPromptError(error)) {
			process.stdout.write('\n');
			process.exit(130);
		}
		throw error;
	}
}

export const prompts = {
	confirm: (...args: Parameters<typeof confirm>) => guardExitPrompt(rawPrompts.confirm(...args)),
	input: (...args: Parameters<typeof input>) => guardExitPrompt(rawPrompts.input(...args)),
	password: (...args: Parameters<typeof password>) => guardExitPrompt(rawPrompts.password(...args)),
	select: (...args: Parameters<typeof select>) => guardExitPrompt(rawPrompts.select(...args)),
};

// Exposed only so unit tests can stub the implementation underneath the exit-prompt guard above
// (`prompts.input = stub` would replace the guard itself, bypassing the ExitPromptError handling
// this seam exists to cover) — production code never reads this directly.
export const rawPromptsForTesting = rawPrompts;
