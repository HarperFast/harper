import { table } from '../resources/databases';
import { keyArrayToString, resources } from '../resources/Resources';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { warn, trace } from '../utility/logging/harper_logger';
import { transaction } from '../resources/transaction';
import { getWorkerIndex } from '../server/threads/manageThreads';
import { when_components_loaded } from '../server/threads/threadServer';
import { server } from '../server/Server';

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
		await when_components_loaded;
		await new Promise((resolve) => setTimeout(resolve, 2000));
		for await (const will of LastWill.search({})) {
			const data = will.data;
			const message = Object.assign({}, will);
			if (message.user?.username) message.user = await server.getUser(message.user.username);
			transaction(message, () => {
				try {
					publish(message, data, message);
				} catch (error) {
					warn('Failed to publish will', data);
				}
				LastWill.delete(will.id, message);
			});
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
 * @param session_id
 * @param user
 * @param non_durable
 */
export async function getSession({
	clientId: session_id,
	user,
	clean: non_durable,
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
	if (session_id && !non_durable) {
		const session_resource = await DurableSession.get(session_id, { returnNonexistent: true });
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
	if (will) {
		will.id = session_id;
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
	request: any;
	socket: any;
	subscriptions = [];
	awaitingAcks: Map<number, any>;
	sessionWasPresent: boolean;
	keepalive: number;
	keepaliveTimer: any;
	constructor(session_id, user) {
		this.sessionId = session_id;
		this.user = user;
	}
	async addSubscription(subscription_request, needs_ack, filter?) {
		const { topic, rh: retain_handling, startTime: start_time } = subscription_request;
		const search_index = topic.indexOf('?');
		let search, path;
		if (search_index > -1) {
			search = topic.slice(search_index);
			path = topic.slice(0, search_index);
		} else path = topic;
		if (!path) throw new Error('No topic provided');
		if (path.indexOf('.') > -1) throw new Error('Dots are not allowed in topic names');
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		let omit_current;
		if (existing_subscription) {
			omit_current = retain_handling > 0;
			existing_subscription.end();
			this.subscriptions.splice(this.subscriptions.indexOf(existing_subscription), 1);
		} else {
			omit_current = retain_handling === 2;
		}
		const request = {
			search,
			async: true,
			user: this.user,
			startTime: start_time,
			omitCurrent: omit_current,
			url: '',
		};
		if (start_time) trace('Resuming subscription from', topic, 'from', start_time);
		const entry = resources.getMatch(path, 'mqtt');
		if (!entry) {
			const not_found_error = new Error(
				`The topic ${topic} does not exist, no resource has been defined to handle this topic`
			);
			not_found_error.statusCode = 404;
			throw not_found_error;
		}
		request.url = entry.relativeURL;
		if (request.url.indexOf('+') > -1 || request.url.indexOf('#') > -1) {
			const path = request.url.slice(1); // remove leading slash
			if (path.indexOf('#') > -1 && path.indexOf('#') !== path.length - 1)
				throw new Error('Multi-level wildcards can only be used at the end of a topic');
			// treat as a collection to get all children, but we will need to filter out any that are not direct children or matching the pattern
			request.isCollection = true;
			if (path.indexOf('+') === path.length - 1) {
				// if it is only a trailing single-level wildcard, we can treat it as a shallow wildcard
				// and use the optimized onlyChildren option, which will be faster, and does not require any filtering
				request.onlyChildren = true;
				request.url = '/' + path.slice(0, path.length - 1);
			} else {
				// otherwise we have a potentially complex wildcard, so we will need to filter out any that are not direct children or matching the pattern
				const matching_path = path.split('/');
				let needs_filter;
				for (let i = 0; i < matching_path.length; i++) {
					if (matching_path[i].indexOf('+') > -1) {
						if (matching_path[i] === '+') needs_filter = true;
						else throw new Error('Single-level wildcards can only be used as a topic level (between or after slashes)');
					}
				}
				if (filter && needs_filter) throw new Error('Filters can not be combined');

				let must_match_length = true;
				if (matching_path[matching_path.length - 1] === '#') {
					// only for any extra topic levels beyond the matching path
					matching_path.length--;
					must_match_length = false;
				}
				if (needs_filter) {
					filter = (update) => {
						const update_path = update.id;
						if (!Array.isArray(update_path)) return false;
						if (must_match_length && update_path.length !== matching_path.length) return false;
						for (let i = 0; i < matching_path.length; i++) {
							if (matching_path[i] !== '+' && matching_path[i] !== update_path[i]) return false;
						}
						return true;
					};
				}
				const first_wildcard = matching_path.indexOf('+');
				request.url =
					'/' + (first_wildcard > -1 ? matching_path.slice(0, first_wildcard) : matching_path).concat('').join('/');
			}
		}

		const resource_path = entry.path;
		const resource = entry.Resource;
		const subscription = await transaction(request, async () => {
			const context = this.createContext();
			context.topic = topic;
			context.retainHandling = retain_handling;
			const subscription = await resource.subscribe(request, context);
			if (!subscription) {
				throw new Error(`No subscription was returned from subscribe for topic ${topic}`);
			}
			if (!subscription[Symbol.asyncIterator])
				throw new Error(`Subscription is not (async) iterable for topic ${topic}`);
			const result = (async () => {
				for await (const update of subscription) {
					try {
						let message_id;
						if (
							update.type &&
							update.type !== 'put' &&
							update.type !== 'delete' &&
							update.type !== 'message' &&
							update.type !== 'patch'
						)
							continue;
						if (filter && !filter(update)) continue;
						if (needs_ack) {
							update.topic = topic;
							message_id = this.needsAcknowledge(update);
						} else {
							// There is no ack to wait for. We can immediately notify any interested source
							// that we have sent the message
							update.acknowledge?.();
							message_id = getNextMessageId();
						}
						let path = update.id;
						if (Array.isArray(path)) path = keyArrayToString(path);
						if (path == null) path = '';
						const result = await this.listener(
							resource_path + '/' + path,
							update.value,
							message_id,
							subscription_request
						);
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
		subscription.topic = topic;
		subscription.qos = subscription_request.qos;
		this.subscriptions.push(subscription);
		return subscription;
	}
	resume() {
		// nothing to do in a clean session
	}
	needsAcknowledge(update) {
		const message_id = getNextMessageId();
		if (update.acknowledge) {
			// only need to track if the source wants acknowledgements
			if (!this.awaitingAcks) this.awaitingAcks = new Map();
			this.awaitingAcks.set(message_id, update.acknowledge);
		}
		return message_id;
	}
	acknowledge(message_id) {
		const acknowledge = this.awaitingAcks?.get(message_id);
		if (acknowledge) {
			this.awaitingAcks.delete(message_id);
			acknowledge();
		}
	}
	async removeSubscription(topic) {
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existing_subscription) {
			// end the subscription, cleanup
			existing_subscription.end();
			// remove from our list of subscriptions
			this.subscriptions.splice(this.subscriptions.indexOf(existing_subscription), 1);
			return true;
		}
	}
	async publish(message, data) {
		// each publish gets it own context so that each publish gets it own transaction
		return publish(message, data, this.createContext());
	}
	createContext() {
		const context = {
			session: this,
			socket: this.socket,
			user: this.user,
			authorize: true, // authorize each action
		};
		if (this.request) {
			context.request = this.request;
			context.url = this.request.url;
			context.headers = this.request.headers;
		}
		return context;
	}
	setListener(listener: (message) => any) {
		this.listener = listener;
	}
	disconnect(client_terminated) {
		if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
		const context = this.createContext();
		transaction(context, async () => {
			try {
				if (!client_terminated) {
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
	message.url = entry.relativeURL;
	const resource = entry.Resource;

	return transaction(context, () => {
		return retain
			? data === undefined
				? resource.delete(message, context)
				: resource.put(message, message.data, context)
			: resource.publish(message, message.data, context);
	});
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
		const ack_info = {
			topic: update.topic,
			timestamp: update.timestamp,
		};
		if (update.acknowledge) ack_info.acknowledge = update.acknowledge;
		this.awaitingAcks.set(message_id, ack_info);
		return message_id;
	}
	acknowledge(message_id) {
		const update = this.awaitingAcks?.get(message_id);
		if (!update) return;
		this.awaitingAcks?.delete(message_id);
		update.acknowledge?.();
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
		if (qos > 0 && !start_time) this.saveSubscriptions();
		return subscription.qos;
	}
	removeSubscription(topic) {
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		const result = super.removeSubscription(topic);
		if (existing_subscription.qos > 0) this.saveSubscriptions();
		return result;
	}
	saveSubscriptions() {
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
}
