import assert from 'node:assert';
export class Echo extends Resource {
	async connect(incoming_messages) {
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
		global.headersTest = this.getContext().headers;
		this.addedProperty = true;
		return super.get(query);
	}
	post(data) {
		this.subObject.set('subProperty', data.subPropertyValue);
		this.subArray.push(data.subArrayItem);
		return 'success';
	}
}
tables.FourProp.setComputedAttribute('ageInMonths', (instance) => instance.age * 12);
export const namespace = {
	SubObject,
};
class SimpleCacheSource extends tables.FourProp {
	get(query) {
		if (this.getId().includes?.('error')) {
			throw new Error('Test error');
		}
		if (this.getId() === 'undefined') return undefined;
		return super.get(query);
	}
}
export class SimpleCache extends tables.SimpleCache.sourcedFrom(SimpleCacheSource) {
	post(data) {
		if (data.invalidate) this.invalidate();
		if (data.customResponse) {
			return {
				status: 222,
				headers: {
					'x-custom-header': 'custom value',
				},
				data: { property: 'custom response' },
			};
		}
	}
	async delete(query) {
		tables.SimpleCache.lastDeleteData = await this.getContext()?.data;
		return super.delete(query);
	}
}
export class FourPropWithHistory extends tables.FourProp {
	static acknowledgements = 0;
	async subscribe(options) {
		let context = this.getContext();
		assert(context.session?.subscriptions);
		assert(context.user);
		assert(context.socket);
		options.previousCount = 10;
		const subscription = await super.subscribe(options);
		for (let update of subscription.queue) {
			update.acknowledge = () => {
				FourPropWithHistory.acknowledgements++;
			};
		}

		const super_send = subscription.send;
		subscription.send = (event) => {
			event.acknowledge = () => {
				FourPropWithHistory.acknowledgements++;
			};
			return super_send.call(subscription, event);
		};
		return subscription;
	}
}
let superGetUser = server.getUser;
server.getUser = function (username, password) {
	if (username === 'restricted' && password === 'restricted') {
		return {
			role: {
				permission: {
					test: {
						tables: {
							SimpleRecord: {
								read: false,
								insert: false,
								update: false,
								delete: false,
							},
						},
					},
				},
			},
		};
	}
	return superGetUser(username, password);
};
