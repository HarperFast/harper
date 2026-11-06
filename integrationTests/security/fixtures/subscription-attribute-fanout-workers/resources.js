import { threadId } from 'node:worker_threads';

// GET reports the worker serving the request; subscribe() reports the worker serving the subscribing connection.
export class WorkerProbe extends Resource {
	// open to every role so a restricted connection can learn its own worker
	allowRead() {
		return true;
	}
	get() {
		return { threadId };
	}
	subscribe() {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: 'message', id: 'item', value: { threadId } };
			},
			end() {},
		};
	}
}
