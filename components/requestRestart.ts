import { Status } from '../server/status/index.ts';

interface NotifyingArrayBuffer extends ArrayBuffer {
	notify(): void;
	cancel(): void;
}

let restartArrayBuffer: NotifyingArrayBuffer;
let restartNeededArray: Uint8Array;
let onRestartRequestedCallback: (() => void) | null = null;

function ensureInitialized() {
	if (!restartArrayBuffer) {
		restartArrayBuffer = Status.primaryStore.getUserSharedBuffer('restart-needed', new ArrayBuffer(1), {
			callback: () => onRestartRequestedCallback?.(),
		}) as NotifyingArrayBuffer;
		restartNeededArray = new Uint8Array(restartArrayBuffer);
	}
}

export function requestRestart() {
	ensureInitialized();
	restartNeededArray[0] = 1;
	restartArrayBuffer.notify();
}

export function restartNeeded() {
	ensureInitialized();
	return restartNeededArray[0] === 1;
}

export function resetRestartNeeded() {
	ensureInitialized();
	restartNeededArray[0] = 0;
}

export function subscribeToRestartRequests(callback: () => void) {
	ensureInitialized();
export function subscribeToRestartRequests(callback: () => void) {
	ensureInitialized();
	if (onRestartRequestedCallback) throw new Error('A restart-request subscriber is already registered');
	onRestartRequestedCallback = callback;
}
}
