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

class SubObject extends tables.SubObject {
	get(query) {
		this.addedProperty = true;
		return super.get(query);
	}
	post(data) {
		this.subObject.set('subProperty', data.subPropertyValue);
		this.subArray.push(data.subArrayItem);
		return 'success';
	}
}
export const namespace = {
	SubObject,
};
class SimpleCacheSource extends tables.FourProp {}
export class SimpleCache extends tables.SimpleCache.sourcedFrom(SimpleCacheSource) {
	post(data) {
		if (data.invalidate) this.invalidate();
	}
}
export class FourPropWithHistory extends tables.FourProp {
	subscribe(options) {
		options.previousCount = 10;
		return super.subscribe(options);
	}
}
