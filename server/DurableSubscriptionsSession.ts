import { table } from '../resources/databases';
import { keyArrayToString, resources } from '../resources/Resources';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { warn, trace } from '../utility/logging/harper_logger';
import { transaction } from '../resources/transaction';
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
 * @param session_id
 * @param user
 * @param non_durable
 */
export async function getSession({
	clientId: session_id,
	user,
	listener,
	clean: non_durable,
}: {
	clientId;
	user;
	listener: Function;
	clean?: boolean;
}) {
	let session;
	if (session_id && !non_durable) {
		const session_resource = await DurableSession.getResource(session_id, {});
		session = new DurableSubscriptionsSession(session_id, user, session_resource);
		if (session_resource) session.sessionWasPresent = true;
	} else {
		if (session_id) {
			// connecting with a clean session and session id is how durable sessions are deleted
			const session_resource = await DurableSession.get(session_id);
			if (session_resource) session_resource.delete();
		}
		session = new SubscriptionsSession(session_id, user);
	}
	return session;
}
let next_message_id = 1;
function getNextMessageId() {
	next_message_id++;
	// MQTT only supports 16-bit message ids, so must roll over before getting beyond 16-bit ids.
	if (next_message_id > 65500) next_message_id = 1;
	return next_message_id;
}
class SubscriptionsSession {
	listener: (message, subscription, timestamp, qos) => any;
	sessionId: any;
	user: any;
	subscriptions = [];
	awaitingAcks: Map<number, any>;
	sessionWasPresent: boolean;
	constructor(session_id, user) {
		this.sessionId = session_id;
		this.user = user;
	}
	async addSubscription(subscription_request, needs_ack, filter?) {
		const { topic, omitCurrent: rh, startTime: start_time } = subscription_request;
		const search_index = topic.indexOf('?');
		let search, path;
		if (search_index > -1) {
			search = topic.slice(search_index);
			path = topic.slice(0, search_index);
		} else path = topic;
		if (!path) throw new Error('No topic provided');
		let is_collection = false;
		let is_shallow_wildcard;
		if (path.endsWith('+') || path.endsWith('#')) {
			is_collection = true;
			if (path.endsWith('+')) is_shallow_wildcard = true;
			// handle wildcard
			path = path.slice(0, path.length - 1);
		}

		if (path.indexOf('.') > -1) throw new Error('Dots are not allowed in topic names');
		if (path.indexOf('#') > -1 || path.indexOf('+') > -1) throw new Error('Only trailing wildcards are supported');
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existing_subscription) {
			existing_subscription.end();
			this.subscriptions.splice(this.subscriptions.indexOf(existing_subscription), 1);
		}
		const request = {
			search,
			user: this.user,
			startTime: start_time,
			omitCurrent: rh,
			isCollection: is_collection,
			shallowWildcard: is_shallow_wildcard,
			url: '',
		};
		const entry = resources.getMatch(path);
		if (!entry) throw new Error(`The topic ${topic} does not exist, no resource has been defined to handle this topic`);
		request.url = entry.relativeURL;
		const resource_path = entry.path;
		const resource = entry.Resource;
		const subscription = await transaction(request, async () => {
			const subscription = await resource.subscribe(request);
			if (!subscription) throw new Error(`No subscription was returned from subscribe for topic ${topic}`);
			if (!subscription[Symbol.asyncIterator])
				throw new Error(`Subscription is not (async) iterable for topic ${topic}`);
			(async () => {
				for await (const update of subscription) {
					try {
						let message_id;
						if (update.type && update.type !== 'put' && update.type !== 'delete' && update.type !== 'message') continue;
						if (filter && !filter(update)) continue;
						if (needs_ack) {
							update.topic = topic;
							message_id = this.needsAcknowledge(update);
						} else message_id = getNextMessageId();
						let path = update.id;
						if (Array.isArray(path)) path = keyArrayToString(path);
						if (path == null) path = '';
						this.listener(resource_path + '/' + path, update.value, message_id, subscription_request);
					} catch (error) {
						warn(error);
					}
				}
			})();
			return subscription;
		});
		subscription.topic = topic;
		subscription.qos = subscription_request.qos;
		this.subscriptions.push(subscription);
		return subscription;
	}
	resume() {
		// nothing to do in a clean session
	}
	needsAcknowledge(update) {
		return getNextMessageId();
	}
	acknowledge(message_id) {
		// nothing to do in a clean session
	}
	async removeSubscription(topic) {
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existing_subscription) existing_subscription.end();
	}
	async publish(message, data) {
		const { topic, retain } = message;
		message.data = data;
		message.user = this.user;
		const entry = resources.getMatch(topic);
		if (!entry)
			throw new Error(
				`Can not publish to topic ${topic} as it does not exist, no resource has been defined to handle this topic`
			);
		message.url = entry.relativeURL;
		const resource = entry.Resource;

		return transaction(message, () => {
			return retain
				? data === undefined
					? resource.delete(message, message)
					: resource.put(message, message.data, message)
				: resource.publish(message, message.data, message);
		});
	}
	setListener(listener: (message) => any) {
		this.listener = listener;
	}
	disconnect() {
		for (const subscription of this.subscriptions) {
			subscription.end();
		}
		this.subscriptions = [];
	}
}
export class DurableSubscriptionsSession extends SubscriptionsSession {
	sessionRecord: any;
	constructor(session_id, user, record?) {
		super(session_id, user);
		this.sessionRecord = record || { id: session_id, subscriptions: [] };
	}
	async resume() {
		// resuming a session, we need to resume each subscription
		for (const subscription of this.sessionRecord.subscriptions || []) {
			await this.resumeSubscription(
				{ omitCurrent: true, topic: subscription.topic, qos: subscription.qos, startTime: subscription.startTime },
				true,
				subscription.acks
					? (update) => {
							return !subscription.acks.includes(update.timestamp);
					  }
					: null
			);
		}
	}
	resumeSubscription(subscription, needs_ack, filter?) {
		return super.addSubscription(subscription, needs_ack, filter);
	}
	needsAcknowledge(update) {
		if (!this.awaitingAcks) this.awaitingAcks = new Map();
		const message_id = getNextMessageId();
		this.awaitingAcks.set(message_id, { topic: update.topic, timestamp: update.timestamp });
		return message_id;
	}
	acknowledge(message_id) {
		const update = this.awaitingAcks.get(message_id);
		this.awaitingAcks.delete(message_id);
		const topic = update.topic;
		for (const [, remaining_update] of this.awaitingAcks) {
			if (remaining_update.topic === topic) {
				if (remaining_update.timestamp < update.timestamp) {
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

	async addSubscription(subscription, needs_ack) {
		await this.resumeSubscription(subscription, needs_ack);
		const { qos, startTime: start_time } = subscription;
		if (qos > 0 && !start_time) {
			this.sessionRecord.subscriptions = this.subscriptions.map((subscription) => {
				let start_time = subscription.startTime;
				if (!start_time) start_time = subscription.startTime = getNextMonotonicTime();
				trace('Added durable subscription', subscription.topic, start_time);
				return {
					qos: subscription.qos,
					topic: subscription.topic,
					startTime: start_time,
				};
			});
			DurableSession.put(this.sessionRecord);
		}
		return subscription.qos;
	}
}
