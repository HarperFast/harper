import { Status } from '../server/status/index.ts';
import { getWorkerIndex } from '../server/threads/manageThreads.js';

/**
 * A shared, per-thread signal of whether a thread currently has any component in an error state,
 * so the availability read can reflect a failed load on any thread without a cross-thread round
 * trip on every status poll (#3184). get_status runs on the operations thread, which loads
 * components with isWorker=false and never runs handleApplication, so a plugin that fails only on
 * an HTTP worker is invisible in the operations thread's own registry. Each thread instead
 * publishes its own error state into a slot here (the same shared-buffer mechanism restartNeeded
 * uses), and the availability read ORs the slots locally.
 *
 * Sized well past any real thread count; the slot index is the worker index (the operations thread
 * takes slot 0). A thread that dies mid-error leaves its slot set until its replacement re-publishes
 * on the next load, which is the fail-safe direction (the node stays drained, never wrongly in
 * rotation).
 */
const SLOTS = 1024;
let sharedBytes: Uint8Array | undefined;

function bytes(): Uint8Array | undefined {
	if (!sharedBytes) {
		try {
			const buffer = Status.primaryStore.getUserSharedBuffer('component-health', new ArrayBuffer(SLOTS));
			sharedBytes = new Uint8Array(buffer);
		} catch {
			// The status store is not open yet (very early boot); publishing is best-effort and the
			// next status change retries. A missed early write cannot wrongly keep the node in
			// rotation, because the read below returns false only when no slot is set.
			return undefined;
		}
	}
	return sharedBytes;
}

function localSlot(): number {
	const index = getWorkerIndex();
	return (index === undefined ? 0 : index + 1) % SLOTS;
}

/** Publish whether THIS thread currently has any component in an error state. */
export function setLocalComponentError(hasError: boolean): void {
	const buffer = bytes();
	if (buffer) buffer[localSlot()] = hasError ? 1 : 0;
}

/** Whether ANY thread currently reports a component in error. Local read, no cross-thread round trip. */
export function anyThreadHasComponentError(): boolean {
	const buffer = bytes();
	return buffer ? buffer.some((value) => value !== 0) : false;
}
