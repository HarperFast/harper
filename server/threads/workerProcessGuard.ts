/**
 * Worker thread process guard.
 *
 * Components loaded into Harper workers (Next.js, in particular) register
 * their own `unhandledRejection` handler that explicitly calls
 * `process.exit()`. That terminates the entire worker — including
 * replication and unrelated components — for what is logically an
 * application-level error.
 *
 * In worker threads, this module:
 *   - Intercepts `process.exit()` so component code cannot terminate the
 *     worker. The original exit is preserved as `process._realExit` (and
 *     as the exported `realExit()` helper) for Harper internal callers
 *     that legitimately need to terminate the worker (shutdown,
 *     FORCE_EXIT under Bun, etc.).
 *   - Registers an `unhandledRejection` listener so the default Node.js
 *     terminate-on-unhandled-rejection behavior is suppressed when no
 *     other component handler exists.
 *
 * On the main thread this module is a no-op except for exposing
 * `process._realExit` so internal callers can use the same name regardless
 * of thread.
 *
 * Harper-internal callers that intentionally want to terminate should use
 * the exported `realExit()` helper. It falls back to `process.exit` when
 * the guard has not been loaded (e.g., CLI bin scripts), so the helper is
 * always safe to call.
 */

import { isMainThread, threadId } from 'node:worker_threads';
import * as harperLogger from '../../utility/logging/harper_logger.ts';

declare global {
	namespace NodeJS {
		interface Process {
			_realExit: (code?: number) => never;
		}
	}
}

const realExitImpl = process.exit.bind(process) as (code?: number) => never;

// Expose the real exit on every thread so internal Harper callers have a
// stable name to use regardless of which thread they run on. Make it
// non-writable so component code cannot accidentally reassign it, but leave
// it configurable so test doubles (sinon, etc.) can stub it.
if (!process._realExit) {
	Object.defineProperty(process, '_realExit', {
		value: realExitImpl,
		writable: false,
		configurable: true,
		enumerable: false,
	});
}

/**
 * Terminate the current process for real, bypassing the worker process
 * guard's `process.exit` override. Safe to call from any thread — falls
 * back to `process.exit` when the guard has not been loaded yet (e.g.,
 * CLI bin scripts).
 */
export function realExit(code?: number): never {
	// Prefer the (non-writable) `process._realExit` so test doubles that
	// stub `_realExit` can intercept Harper-intentional exits. Fall back
	// to `process.exit` when the guard hasn't been loaded.
	return (process._realExit ?? process.exit)(code);
}

if (!isMainThread) {
	// Replace the public process.exit. Component code calling this — directly
	// or via a framework's `unhandledRejection` handler — should not be able
	// to terminate the worker.
	const interceptedExit = ((code?: number): never => {
		const callSite = new Error('process.exit() intercepted').stack;
		harperLogger.error(
			`process.exit(${code ?? ''}) called in worker thread ${threadId} — ignored to keep Harper alive. ` +
				`Use process._realExit() for legitimate internal shutdown.\n${callSite}`
		);
		// `never` is a structural lie here; we return undefined. Callers that
		// rely on `process.exit` being terminal (e.g. dead-code analysis after
		// the call) will see execution continue, which is the desired
		// resilience behavior.
		return undefined as never;
	}) as typeof process.exit;
	process.exit = interceptedExit;

	// Defense in depth: if no other listener is registered, Node.js terminates
	// the process on an unhandled rejection. Register a logging listener so the
	// worker survives even when no component handler is loaded.
	process.on('unhandledRejection', (reason) => {
		harperLogger.error(`unhandledRejection in worker thread ${threadId}:`, reason);
	});
}
