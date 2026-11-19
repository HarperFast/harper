import { threadId } from 'node:worker_threads';

export class WorkerThread extends Resource {
	static loadAsInstance = false;
	get() {
		return { threadId };
	}
}
