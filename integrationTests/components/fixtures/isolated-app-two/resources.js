import { Resource } from 'harper';
import { threadId } from 'node:worker_threads';

export class IsolatedTwo extends Resource {
	get() {
		return { application: 'isolated-app-two', threadId };
	}
}
