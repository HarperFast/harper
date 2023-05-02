import { Resource } from 'harperdb';

export class Echo extends Resource {
	static async *connect(incoming_messages) {
		if (incoming_messages) {
			// echo service for WebSockets
			for await (let message of incoming_messages) {
				yield message;
			}
		} else {
			// for server sent events, just send greetings
			while (true) {
				yield 'greetings';
				await new Promise((resolve) => setTimeout(resolve, 10000));
			}
		}
	}
	get() {
		return this.id;
	}
}

console.log('resources');
