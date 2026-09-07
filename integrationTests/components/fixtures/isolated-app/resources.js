import { Resource } from 'harper';
import { threadId } from 'node:worker_threads';

export class Isolated extends Resource {
	get() {
		return { application: 'isolated-app', threadId };
	}
}
