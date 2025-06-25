import { Status } from '../server/status/index.ts';

let restartArrayBuffer: ArrayBuffer;
let restartNeededArray: Uint8Array;

function ensureInitialized() {
	if (!restartArrayBuffer) {
		restartArrayBuffer = Status.primaryStore.getUserSharedBuffer('restart-needed', new ArrayBuffer(1));
		restartNeededArray = new Uint8Array(restartArrayBuffer);
	}
}

export function requestRestart() {
	ensureInitialized();
	restartNeededArray[0] = 1;
}

export function restartNeeded() {
	ensureInitialized();
	return restartNeededArray[0] === 1;
}

export function resetRestartNeeded() {
	ensureInitialized();
	restartNeededArray[0] = 0;
}
