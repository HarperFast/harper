import { threadId } from 'node:worker_threads';

export class Worker extends Resource {
	get() {
		return { threadId };
	}
}
