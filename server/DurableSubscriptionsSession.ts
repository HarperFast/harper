import { table } from '../resources/databases.ts';
import { keyArrayToString, resources } from '../resources/Resources.ts';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.js';
import { warn, trace } from '../utility/logging/harper_logger.js';
import { transaction } from '../resources/transaction.ts';
import { getWorkerIndex } from '../server/threads/manageThreads.js';
import { whenComponentsLoaded } from '../server/threads/threadServer.js';
import { server } from '../server/Server.ts';
import { RequestTarget } from '../resources/RequestTarget';

const AWAITING_ACKS_HIGH_WATER_MARK = 100;
const DurableSession = table({
	database: 'system',
	table: 'hdb_durable_session',
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{
			name: 'subscriptions',
			type: 'array',
			elements: {
				attributes: [{ name: 'topic' }, { name: 'qos' }, { name: 'startTime' }, { name: 'acks' }],
			},
		},
	],
});
const LastWill = table({
	database: 'system',
	table: 'hdb_session_will',
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'topic', type: 'string' },
		{ name: 'data' },
		{ name: 'qos', type: 'number' },
		{ name: 'retain', type: 'boolean' },
		{ name: 'user', type: 'any' },
	],
});
if (getWorkerIndex() === 0) {
	(async () => {
		await whenComponentsLoaded;
		await new Promise((resolve) => setTimeout(resolve, 2000));
		for await (const will of LastWill.search({})) {
			const data = will.data;
			const message = { ...will };
			if (message.user?.username) message.user = await server.getUser(message.user.username);
			try {
				await publish(message, data, message);
			} catch (error) {
				warn('Failed to publish will', data);
			}
			LastWill.delete(will.id);
		}
	})();
}

/**
 * This is used for durable sessions, that is sessions in MQTT that are not "clean" sessions (and with QoS >= 1
 * subscriptions) and durable AMQP queues, with real-time communication and reliable delivery that requires tracking
 * delivery and acknowledgement. This particular function is used to start or retrieve such a session.
 * A session can be durable (maintains state) or clean (no state). A durable session is stored in a system table as a
 * record that holds a list of subscriptions (topic and QoS), the timestamp of last message, and any unacked messages
 * before the timestamp. Once this is returned, it makes the subscription "live", actively routing data through it. Any
 * catch-up from topics, that is subscriptions to records, need to be performed first.
 * The structure is designed such that no changes need to be made to it while it is at "rest". That means that if there
 * are no active listeners to this session, no active processing of subscriptions and matching messages needs to be
 * performed. All subscription handling can be resumed when the session is reconnected, and can be performed on the
 * node that is active. The timestamps indicate all updates that need to be retrieved prior to being live again.
 * Note, that this could be contrasted with a continuously active session or queue, that is continually monitoring
 * for published messages on subscribed topics. This would require a continuous process to perform routing, and on
 * a distributed network, it could be extremely difficult and unclear who should manage and handle this. This would also
 * involve extra overhead when sessions are not active, and may never be accessed again. With our approach, an
 * abandoned durable session can simply sit idle with no resources taken, and optionally expired by simply deleting the
 * session record at some point.
 * However, because resuming durable sessions requires catch-up on subscriptions, this means we must have facilities in
 * place for being able to query for the log of changes/messages on each of the subscribed records of interest. We do
 * this by querying the audit log, but we will need to ensure the audit log is enabled on any tables/records that receive
 * subscriptions.
 * @param sessionId
 * @param user
 * @param nonDurable
 */
export async function getSession({
	clientId: sessionId,
	user,
	clean: nonDurable,
	will,
	keepalive,
}: {
	clientId;
	user;
	listener: Function;
	clean?: boolean;
	will: any;
	keepalive?: number;
}) {
	let session;
	if (sessionId && !nonDurable) {
		const sessionResource = await DurableSession.get(sessionId, { returnNonexistent: true });
		session = new DurableSubscriptionsSession(sessionId, user, sessionResource);
		if (sessionResource) session.sessionWasPresent = true;
	} else {
		if (sessionId) {
			// connecting with a clean session and session id is how durable sessions are deleted
			const sessionResource = await DurableSession.get(sessionId);
			if (sessionResource) sessionResource.delete();
		}
		session = new SubscriptionsSession(sessionId, user);
	}
	if (will) {
		will.id = sessionId;
		will.user = { username: user?.username };
		LastWill.put(will);
	}
	if (keepalive) {
		// keep alive is the interval in seconds that the client will send a ping to the server
		// if the server does not receive a ping within 1.5 times the keep alive interval, it will
		// disconnect the client
		session.keepalive = keepalive;
		session.receivedPacket(); // start the keepalive timer
	}
	return session;
}
let nextMessageId = 1;
function getNextMessageId() {
	nextMessageId++;
	// MQTT only supports 16-bit message ids, so must roll over before getting beyond 16-bit ids.
	if (nextMessageId > 65500) nextMessageId = 1;
	return nextMessageId;
}
type Acknowledgement = {
	topic?: string;
	timestamp?: number;
	acknowledge?: () => any;
};

class SubscriptionsSession {
	listener: (message, subscription, timestamp, qos) => any;
	sessionId: any;
	user: any;
	request: any;
	socket: any;
	subscriptions = [];
	awaitingAcks: Map<number, Acknowledgement>;
	sessionWasPresent: boolean;
	keepalive: number;
	keepaliveTimer: any;
	constructor(sessionId, user) {
		this.sessionId = sessionId;
		this.user = user;
	}
	async addSubscription(subscriptionRequest, needsAck, filter?) {
		const { topic, rh: retainHandling, startTime: startTime } = subscriptionRequest;
		const searchIndex = topic.indexOf('?');
		let search, path;
		if (searchIndex > -1) {
			search = topic.slice(searchIndex);
			path = topic.slice(0, searchIndex);
		} else path = topic;
		if (!path) throw new Error('No topic provided');
		if (path.indexOf('.') > -1) throw new Error('Dots are not allowed in topic names');
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existingSubscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		let omitCurrent;
		if (existingSubscription) {
			omitCurrent = retainHandling > 0;
			existingSubscription.end();
			this.subscriptions.splice(this.subscriptions.indexOf(existingSubscription), 1);
		} else {
			omitCurrent = retainHandling === 2;
		}
		const request = {
			search,
			async: true,
			user: this.user,
			startTime,
			omitCurrent,
			target: '',
		};
		if (startTime) trace('Resuming subscription from', topic, 'from', startTime);
		const entry = resources.getMatch(path, 'mqtt');
		if (!entry) {
			const notFoundError = new Error(
				`The topic ${topic} does not exist, no resource has been defined to handle this topic`
			);
			notFoundError.statusCode = 404;
			throw notFoundError;
		}
		request.target = entry.relativeURL;
		let hashIndex: number;
		if (request.target.indexOf('+') > -1 || (hashIndex = request.target.indexOf('#')) > -1) {
			const path = request.target.slice(1); // remove leading slash
			hashIndex--; // adjust accordingly
			if (hashIndex > -1 && hashIndex !== path.length - 1)
				throw new Error('Multi-level wildcards can only be used at the end of a topic');
			// treat as a collection to get all children, but we will need to filter out any that are not direct children or matching the pattern
			request.isCollection = true; // used by Resource to determine if the resource should be treated as a collection
			if (path.indexOf('+') === path.length - 1) {
				// if it is only a trailing single-level wildcard, we can treat it as a shallow wildcard
				// and use the optimized onlyChildren option, which will be faster, and does not require any filtering
				request.onlyChildren = true;
				request.target = '/' + path.slice(0, path.length - 1);
			} else {
				// otherwise we have a potentially complex wildcard, so we will need to filter out any that are not direct children or matching the pattern
				const matchingPath = path.split('/');
				let needsFilter;
				for (let i = 0; i < matchingPath.length; i++) {
					if (matchingPath[i].indexOf('+') > -1) {
						if (matchingPath[i] === '+') needsFilter = true;
						else throw new Error('Single-level wildcards can only be used as a topic level (between or after slashes)');
					}
				}
				if (filter && needsFilter) throw new Error('Filters can not be combined');

				let mustMatchLength = true;
				if (matchingPath[matchingPath.length - 1] === '#') {
					// only for any extra topic levels beyond the matching path
					matchingPath.length--;
					mustMatchLength = false;
				}
				if (needsFilter) {
					filter = (update) => {
						let updatePath = update.id;
						if (!Array.isArray(updatePath)) {
							if (updatePath?.indexOf?.('/') > -1) {
								// if it is a string with slashes, we can split it into an array
								updatePath = updatePath.split('/');
							} else {
								return false;
							}
						}
						if (mustMatchLength && updatePath.length !== matchingPath.length) return false;
						for (let i = 0; i < matchingPath.length; i++) {
							if (matchingPath[i] !== '+' && matchingPath[i] !== updatePath[i]) return false;
						}
						return true;
					};
				}
				const firstWildcard = matchingPath.indexOf('+');
				request.target =
					'/' + (firstWildcard > -1 ? matchingPath.slice(0, firstWildcard) : matchingPath).concat('').join('/');
			}
		} else request.isCollection = false; // must explicitly turn this off so topics that end in a slash are not treated as collections

		const resourcePath = entry.path;
		const resource = entry.Resource;
		const subscription = await transaction(request, async () => {
			const context = this.createContext();
			context.topic = topic;
			context.retainHandling = retainHandling;
			context.isCollection = request.isCollection;
			const subscription = await resource.subscribe(request, context);
			if (!subscription) {
				return; // if no subscription, nothing to return
			}
			if (!subscription[Symbol.asyncIterator])
				throw new Error(`Subscription is not (async) iterable for topic ${topic}`);
			const result = (async () => {
				for await (const update of subscription) {
					try {
						let messageId;
						if (
							update.type &&
							update.type !== 'put' &&
							update.type !== 'delete' &&
							update.type !== 'message' &&
							update.type !== 'patch'
						)
							continue;
						if (filter && !filter(update)) continue;
						if (needsAck) {
							update.topic = topic;
							messageId = this.needsAcknowledge(update);
						} else {
							// There is no ack to wait for. We can immediately notify any interested source
							// that we have sent the message
							update.acknowledge?.();
							messageId = getNextMessageId();
						}
						let path = update.id;
						if (Array.isArray(path)) path = keyArrayToString(path);
						if (path == null) path = '';
						const result = await this.listener(resourcePath + '/' + path, update.value, messageId, subscriptionRequest);
						if (result === false) break;
						if (this.awaitingAcks?.size > AWAITING_ACKS_HIGH_WATER_MARK) {
							// slow it down if we are getting too far ahead in acks
							await new Promise((resolve) =>
								setTimeout(resolve, this.awaitingAcks.size - AWAITING_ACKS_HIGH_WATER_MARK)
							);
						} else await new Promise(setImmediate); // yield event turn
					} catch (error) {
						warn(error);
					}
				}
			})();
			return subscription;
		});
		if (!subscription) return;
		subscription.topic = topic;
		subscription.qos = subscriptionRequest.qos;
		this.subscriptions.push(subscription);
		return subscription;
	}
	resume() {
		// nothing to do in a clean session
	}
	needsAcknowledge(update) {
		const messageId = getNextMessageId();
		if (update.acknowledge) {
			// only need to track if the source wants acknowledgements
			if (!this.awaitingAcks) this.awaitingAcks = new Map();
			this.awaitingAcks.set(messageId, { acknowledge: update.acknowledge });
		}
		return messageId;
	}
	acknowledge(messageId) {
		const acknowledgement = this.awaitingAcks?.get(messageId);
		if (acknowledgement) {
			this.awaitingAcks.delete(messageId);
			acknowledgement.acknowledge();
		}
	}
	async removeSubscription(topic) {
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existingSubscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existingSubscription) {
			// end the subscription, cleanup
			existingSubscription.end();
			// remove from our list of subscriptions
			this.subscriptions.splice(this.subscriptions.indexOf(existingSubscription), 1);
			return true;
		}
	}
	async publish(message, data) {
		// each publish gets it own context so that each publish gets it own transaction
		return publish(message, data, this.createContext());
	}
	createContext(): any {
		const context = {
			session: this,
			socket: this.socket,
			user: this.user,
			authorize: true, // authorize each action
		};
		if (this.request) {
			context.request = this.request;
			context.target = this.request.target;
			context.headers = this.request.headers;
		}
		return context;
	}
	setListener(listener: (message) => any) {
		this.listener = listener;
	}
	disconnect(clientTerminated) {
		if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
		const context = this.createContext();
		transaction(context, async () => {
			try {
				if (!clientTerminated) {
					const will = await LastWill.get(this.sessionId);
					if (will?.doesExist()) {
						await publish(will, will.data, context);
					}
				}
			} finally {
				await LastWill.delete(this.sessionId);
			}
		}).catch((error) => {
			warn(`Error publishing MQTT will for ${this.sessionId}`, error);
		});

		for (const subscription of this.subscriptions) {
			subscription.end();
		}
		this.subscriptions = [];
	}
	receivedPacket() {
		if (this.keepalive) {
			clearTimeout(this.keepaliveTimer);
			this.keepaliveTimer = setTimeout(() => {
				if (this.socket?.destroy) this.socket.destroy(new Error('Keepalive timeout'));
				else this.socket?.terminate();
			}, this.keepalive * 1500);
		}
	}
}
function publish(message, data, context) {
	const { topic, retain } = message;
	message.data = data;
	message.async = true;
	context.authorize = true;
	const entry = resources.getMatch(topic, 'mqtt');
	if (!entry)
		throw new Error(
			`Can not publish to topic ${topic} as it does not exist, no resource has been defined to handle this topic`
		);
	message.target = entry.relativeURL;
	const target = new RequestTarget(entry.relativeURL);

	const resource = entry.Resource;

	return transaction(context, () => {
		return retain
			? data === undefined
				? resource.delete(target, context)
				: resource.put(target, message.data, context)
			: resource.publish(target, message.data, context);
	});
}
export class DurableSubscriptionsSession extends SubscriptionsSession {
	sessionRecord: any;
	constructor(sessionId, user, record?) {
		super(sessionId, user);
		this.sessionRecord = record || { id: sessionId, subscriptions: [] };
	}
	async resume() {
		// resuming a session, we need to resume each subscription
		for (const subscription of this.sessionRecord.subscriptions || []) {
			await this.resumeSubscription(
				{ omitCurrent: true, topic: subscription.topic, qos: subscription.qos, startTime: subscription.startTime },
				true,
				subscription.acks
					? (update) => {
							return !subscription.acks.includes(update.localTime);
						}
					: null
			);
		}
	}
	resumeSubscription(subscription, needsAck, filter?) {
		return super.addSubscription(subscription, needsAck, filter);
	}
	needsAcknowledge(update) {
		if (!this.awaitingAcks) this.awaitingAcks = new Map();
		const messageId = getNextMessageId();
		const ackInfo: Acknowledgement = {
			topic: update.topic,
			timestamp: update.localTime,
		};
		if (update.acknowledge) ackInfo.acknowledge = update.acknowledge;
		this.awaitingAcks.set(messageId, ackInfo);
		return messageId;
	}
	acknowledge(messageId) {
		const update = this.awaitingAcks?.get(messageId);
		if (!update) return;
		this.awaitingAcks?.delete(messageId);
		update.acknowledge?.();
		const topic = update.topic;
		for (const [, remainingUpdate] of this.awaitingAcks) {
			if (remainingUpdate.topic === topic) {
				if (remainingUpdate.timestamp < update.timestamp) {
					// this is an out of order ack, so instead of updating the timestamp, we record as an out-of-order ack
					for (const subscription of this.sessionRecord.subscriptions) {
						if (subscription.topic === topic) {
							if (!subscription.acks) {
								subscription.acks = [];
							}
							subscription.acks.push(update.timestamp);
							trace('Received ack', topic, update.timestamp);
							this.sessionRecord.update();
							return;
						}
					}
				}
			}
		}

		for (const subscription of this.sessionRecord.subscriptions) {
			if (subscription.topic === topic) {
				subscription.startTime = update.timestamp;
			}
		}
		this.sessionRecord.update();
		// TODO: Increment the timestamp for the corresponding subscription, possibly recording any interim unacked messages
	}

	async addSubscription(subscription, needsAck) {
		await this.resumeSubscription(subscription, needsAck);
		const { qos, startTime: startTime } = subscription;
		if (qos > 0 && !startTime) this.saveSubscriptions();
		return subscription.qos;
	}
	removeSubscription(topic) {
		const existingSubscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		const result = super.removeSubscription(topic);
		if (existingSubscription.qos > 0) this.saveSubscriptions();
		return result;
	}
	saveSubscriptions() {
		this.sessionRecord.subscriptions = this.subscriptions.map((subscription) => {
			let startTime = subscription.startTime;
			if (!startTime) startTime = subscription.startTime = getNextMonotonicTime();
			trace('Added durable subscription', subscription.topic, startTime);
			return {
				qos: subscription.qos,
				topic: subscription.topic,
				startTime,
			};
		});
		DurableSession.put(this.sessionRecord);
	}
}
