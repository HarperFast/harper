import { isMainThread, threadId, workerData } from 'node:worker_threads';

export class Runtime extends Resource {
	get() {
		return { isMainThread, threadId, workerIndex: workerData?.workerIndex, noServerStart: !!workerData?.noServerStart };
	}
}
