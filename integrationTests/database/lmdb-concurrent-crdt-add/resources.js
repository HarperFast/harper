import { threadId } from 'node:worker_threads';

// Reports the worker that served the request, so the test can show its writes spread over threads.
export class WorkerThread extends Resource {
	static loadAsInstance = false;
	get() {
		return { threadId };
	}
}
