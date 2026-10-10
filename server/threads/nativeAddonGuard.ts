/**
 * On a V8 pointer-compression runtime, wraps `process.dlopen` (per thread: each worker has its own
 * `process`) so a standard-ABI addon is refused instead of crashing the process; a no-op otherwise.
 * Installs when loaded, so it must be the first module of every Harper thread; see server/DESIGN.md.
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
export function nativeAddonGuardExecArgv(pointerCompression = isPointerCompressionRuntime()): string[] {
	return pointerCompression ? ['--require', __filename] : [];
}

installNativeAddonGuard();
