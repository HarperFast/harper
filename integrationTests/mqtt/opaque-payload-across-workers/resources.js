import { threadId } from 'node:worker_threads';

function yielding(value) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'message', id: 'item', value };
		},
		// the MQTT session ends every subscription it holds when the connection closes
		end() {},
	};
}

// A subscription runs on the worker serving the connection.
export class WorkerProbe extends Resource {
	subscribe() {
		return yielding({ threadId });
	}
}

// No serializer can encode this message.
export class Unserializable extends Resource {
	subscribe() {
		return yielding({
			toJSON() {
				throw new Error('unserializable');
			},
		});
	}
}
