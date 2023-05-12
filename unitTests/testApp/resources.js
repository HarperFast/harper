import * as harperdb from 'harperdb';
import { Resource, tables } from 'harperdb';
console.log({ harperdb });
export class Echo extends Resource {
	static async connect(incoming_messages) {
		if (incoming_messages) {
			// echo service for WebSockets
			return (async function* () {
				for await (let message of incoming_messages) {
					yield message;
				}
			})();
		} else {
			// for server sent events, just send greetings, and try using super.connect
			let outgoing_messages = super.connect();
			outgoing_messages.send('greetings');
			let timer = setTimeout(() => {
				outgoing_messages.send({
					event: 'another-message',
					data: 'hello again',
				});
			}, 10);
			outgoing_messages.on('close', () => {
				clearTimeout(timer);
			});
			return outgoing_messages;
		}
	}
	get() {
		return {
			change: 'this',
			id: this.id,
		};
	}
}

class SimpleCacheSource extends tables.FourProp {}
export class SimpleCache extends tables.SimpleCache.sourcedFrom(SimpleCacheSource) {
	post(data) {
		if (data.invalidate) this.invalidate({});
	}
}
