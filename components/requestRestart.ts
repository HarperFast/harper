import { Status } from '../server/status/index.ts';

const restartArrayBuffer = Status.primaryStore.getUserSharedBuffer('restart-needed', new ArrayBuffer(1));
const restartNeededArray = new Uint8Array(restartArrayBuffer);

export function requestRestart() {
	restartNeededArray[0] = 1;
}

export function restartNeeded() {
	return restartNeededArray[0] === 1;
}

export function resetRestartNeeded() {
	restartNeededArray[0] = 0;
}
