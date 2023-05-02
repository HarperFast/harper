import { Resource } from 'harperdb';

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
			setTimeout(() => {
				outgoing_messages.send({
					event: 'another-message',
					data: 'hello again',
				});
			}, 10);
			return outgoing_messages;
		}
	}
	get() {
		return this.id;
	}
}

console.log('resources');
