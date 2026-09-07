import { Resource } from 'harper';
import { threadId } from 'node:worker_threads';

export class Shared extends Resource {
	get() {
		return { application: 'shared-sibling', threadId };
	}
}
