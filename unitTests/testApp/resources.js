import assert from 'node:assert';
import { createECDH } from 'node:crypto';

export class Echo extends Resource {
	static loadAsInstance = false;
	async connect(target, incomingMessages) {
		if (incomingMessages) {
			// echo service for WebSockets
			return (async function* () {
				for await (let message of incomingMessages) {
					yield message;
				}
			})();
		} else {
			// for server sent events, just send greetings, and try using super.connect
			let outgoingMessages = super.connect(target, incomingMessages);
			outgoingMessages.send('greetings');
			let timer = setTimeout(() => {
				outgoingMessages.send({
					event: 'another-message',
					data: 'hello again',
				});
			}, 10);
			outgoingMessages.on('close', () => {
				clearTimeout(timer);
			});
			return outgoingMessages;
		}
	}
	subscribe(query) {
		if (!query.get || typeof query.url !== 'string') {
			throw new Error('Invalid subscribe query');
		}
		return super.subscribe(query);
	}

	get(target) {
		if (this.getId() === 'error-plain-object') throw { message: 'Test error' };
		if (this.getId() === 'error-bad-body') {
			return {
				status: 400,
				headers: {},
				body: { property: 'not valid' },
			};
		}
		return {
			change: 'this',
			id: this.id,
		};
	}
}

class ResourceA extends Resource {
	get(params) {
		return { name: 'ResourceA', params };
	}
}

class ResourceB extends Resource {
	get(params) {
		return { name: 'ResourceB', params };
	}
}

class ResourceC extends Resource {
	get(params) {
		return { name: 'ResourceC', params };
	}
}

export const api = {
	v1: {
		'resourceA': ResourceA,
		'resourceA/resourceB': ResourceB,
		'resourceA/resourceB/subPath/ResourceC': ResourceC,
	},
};

class SubObject extends tables.SubObject {
	get(query) {
		tables.SubObject.headersTest = this.getContext().headers;
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
tables.SimpleCache.sourcedFrom(SimpleCacheSource);
export class SimpleCache extends tables.SimpleCache {
	static loadAsInstance = false;
	post(query, data) {
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
		if (data.doExpensiveComputation) {
			for (let i = 0; i < 1000; i++) {
				expensiveThing();
			}
		}
	}
	async delete(query) {
		tables.SimpleCache.lastDeleteData = await this.getContext()?.data;
		return super.delete(query);
	}
}
function expensiveThing() {
	const ecdh = createECDH('secp256k1');
	ecdh.generateKeys();
}
export class SimpleCacheLoadAsInstance extends tables.SimpleCache {
	static loadAsInstance = true;
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
tables.CacheOfResource.sourceGetsPerformed = 0;
tables.CacheOfResource.sourcedFrom({
	get() {
		tables.CacheOfResource.sourceGetsPerformed++;
		return {
			name: 'test',
		};
	},
});

export class FourPropWithHistory extends tables.FourProp {
	async subscribe(options) {
		let context = this.getContext();
		assert(context.session?.subscriptions);
		assert(context.user);
		assert(context.socket);
		options.previousCount = 10;
		tables.FourProp.acknowledgements = 0;
		const subscription = await super.subscribe(options);
		for (let update of subscription.queue) {
			update.acknowledge = () => {
				tables.FourProp.acknowledgements++;
			};
		}

		const super_send = subscription.send;
		subscription.send = (event) => {
			event.acknowledge = () => {
				tables.FourProp.acknowledgements++;
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

// These are for the "handles iterator content type handler" tests in unitTests/apiTests/basicREST-test.mjs
server.contentTypes.set('application/custom-async-iterator', {
	async *serializeStream(data) {
		yield 'one';
		yield 'two';
	},
});

server.contentTypes.set('application/custom-iterator', {
	*serializeStream(data) {
		yield 'one';
		yield 'two';
	},
});
