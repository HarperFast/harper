/**
 * Native addon guard for V8 pointer-compression Node.js runtimes.
 *
 * Every `.node` load (CJS require, createRequire, ESM addon import) goes through `process.dlopen`,
 * and each worker thread has its own `process`. On a pointer-compression runtime this wraps
 * `process.dlopen` so an addon built for the standard V8 C++ ABI is refused with an
 * IncompatibleNativeAddonError instead of loading and crashing the process on first use (rules in
 * utility/nativeAddonAbi.ts). On a standard runtime it changes nothing.
 *
 * Installs when loaded, so it must be the first module of every Harper thread: the first import of
 * bin/harper.ts and index.ts on the main thread, and the first `--require` of every worker
 * (`nativeAddonGuardExecArgv()` in startWorker), ahead of `threads.preload`/`threads.preloadRequire`.
 * It imports only Node builtins (through nativeAddonAbi.ts) so that nothing it pulls in loads an
 * addon before the wrapper is in place.
 */
import { assertNativeAddonLoadable, isPointerCompressionRuntime } from '../../utility/nativeAddonAbi.ts';

type Dlopen = (...args: unknown[]) => unknown;

// Symbol.for so a second copy of this module (dist and typestrip paths) sees an existing wrapper
const GUARDED = Symbol.for('harper.nativeAddonGuard');

export function installNativeAddonGuard(
	target: { dlopen: Dlopen } = process as unknown as { dlopen: Dlopen },
	pointerCompression = isPointerCompressionRuntime()
): boolean {
	if (!pointerCompression) return false;
	const originalDlopen = target.dlopen;
	if (originalDlopen[GUARDED]) return true;
	const guardedDlopen = function (this: unknown, ...args: unknown[]) {
		assertNativeAddonLoadable(args[1] as string);
		// Node's dlopen reads the argument count: an explicit undefined flags argument becomes 0, which dlopen(3) rejects
		return Reflect.apply(originalDlopen, this, args);
	};
	guardedDlopen[GUARDED] = true;
	target.dlopen = guardedDlopen;
	return true;
}

/** The `execArgv` entries that install this guard first in a worker thread. */
export function nativeAddonGuardExecArgv(): string[] {
	return isPointerCompressionRuntime() ? ['--require', __filename] : [];
}

installNativeAddonGuard();
