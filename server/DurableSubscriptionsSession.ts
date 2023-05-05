import { table } from '../resources/tableLoader';
import { resources } from '../resources/Resources';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
const DurableSession = table({
	database: 'system',
	table: 'hdb_durable_session',
	attributes: [{ name: 'id', isPrimaryKey: true }],
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
 */
export async function getSession({ clientId: session_id, clean: non_durable }) {
	if (session_id && !non_durable) {
		const session = DurableSession.getResource(session_id);
		await session.loadRecord();
		// resuming a session, we need to resume each subscription
		for (const subscription of session.get('subscriptions') || []) {
			session.addSubscription(subscription);
		}
		return session;
	} else return new SubscriptionsSession(session_id);
}

export class SubscriptionsSession {
	listener: (message, subscription) => any;
	sessionId: any;
	user: any;
	subscriptions = [];
	constructor(session_id) {
		this.sessionId = session_id;
	}
	async addSubscription(subscription_request) {
		const { topic, qos, rh, startTime: start_time } = subscription_request;
		const search_index = topic.indexOf('?');
		let search, path;
		if (search_index > -1) {
			search = topic.slice(search_index);
			path = topic.slice(0, search_index);
		} else path = topic;
		if (path.endsWith('+') || path.endsWith('#'))
			// normalize wildcard
			path = topic.slice(0, path.length - 1);
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existing_subscription) existing_subscription.end();
		let subscription;
		const resource = await resources.call(path, this, async (resource_access) => {
			return (subscription = await resource_access.subscribe({
				listener: (update, id) => {
					this.listener(search ? path + '/' + id : path, update.value);
				},
				search,
				user: this.user,
				startTime: start_time || getNextMonotonicTime(),
				noRetain: rh,
			}));
		});
		subscription.topic = topic;
		this.subscriptions.push(subscription);
	}
	async removeSubscription(topic) {
		const search_index = topic.indexOf('?');
		let path;
		if (search_index > -1) {
			path = topic.slice(0, search_index);
		} else path = topic;
		if (path.endsWith('+') || path.endsWith('#'))
			// normalize wildcard
			path = topic.slice(0, path.length - 1);
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existing_subscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		if (existing_subscription) existing_subscription.end();
	}
	async publish(message, data) {
		const { topic, retain, payload } = message;
		message.data = data;
		message.user = this.user;
		return resources.call(topic, message, async (resource_access) => {
			return resource_access.publish(data);
		});
	}
	setListener(listener: (message) => any) {
		this.listener = listener;
	}
	acknowledge() {
		// TODO: Increment the timestamp for the corresponding subscription, possibly recording any interim unacked messages
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
	constructor(session_id, record?) {
		super(session_id);
		this.sessionRecord = record || { id: session_id, subscriptions: [] };
	}
	async addSubscription(subscription) {
		await super.addSubscription(subscription);
		const { topic, qos, startTime: start_time } = subscription;
		if (qos > 0 && !start_time) {
			// TODO: Add this to the session record with the correct timestamp and save it
			this.sessionRecord.subscriptions.push({ topic, qos, startTime: Date.now() });
			DurableSession.put(this.sessionRecord.id, this.sessionRecord);
		}
		return subscription.qos;
	}
}
