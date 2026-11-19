import harperLogger from '../../utility/logging/harper_logger.ts';
import { MIN_THREAD_HEAP_MEMORY_MB } from '../../utility/hdbTerms.ts';

let recoveryWarned = false;

export function isStartableThreadHeapMemory(configuredMb: unknown): boolean {
	return Number.isFinite(configuredMb) && (configuredMb as number) >= MIN_THREAD_HEAP_MEMORY_MB;
}

// Below the minimum, Node aborts the whole process from v8::Isolate::Initialize before any
// JavaScript runs, so this has to be caught ahead of startWorker — no error handler downstream can
// contain it. The value on disk is an untrusted boot input (replicated, env var, hand edit, older
// peer), so an unstartable one falls back to the caller's computed default rather than stopping the
// node.
export function resolveThreadHeapMemoryMb(configured: unknown): number | undefined {
	if (configured == null) return undefined;
	const configuredMb = Number(configured);
	if (isStartableThreadHeapMemory(configuredMb)) return configuredMb;
	if (!recoveryWarned) {
		recoveryWarned = true;
		harperLogger.error(
			`Ignoring threads.maxHeapMemory: ${JSON.stringify(configured)} is below the ${MIN_THREAD_HEAP_MEMORY_MB}MB a worker thread can start on. Using the default instead; replace the configured value before downgrading.`
		);
	}
	return undefined;
}
