import { table } from '../resources/databases.ts';
import { keyArrayToString, resources } from '../resources/Resources.ts';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.ts';
import { warn, trace } from '../utility/logging/harper_logger.ts';
import { transaction } from '../resources/transaction.ts';
import { getWorkerIndex } from '../server/threads/manageThreads.js';
import { whenComponentsLoaded } from '../server/threads/threadServer.js';
import { server } from '../server/Server.ts';
import { RequestTarget } from '../resources/RequestTarget';
import { randomBytes } from 'node:crypto';
import { auditRetention, getDatabaseGeneration, isResumablePosition } from '../resources/auditStore.ts';
import { exportIdMapping, getNodeNameForId } from '../resources/nodeIdMapping.ts';
import { getThisNodeName } from './nodeName.ts';
import {
	ORIGIN_ID,
	admitCheckpoint,
	validateCheckpoint,
	type SubscriptionCheckpoint,
} from '../resources/subscriptionCheckpoint.ts';

const AWAITING_ACKS_HIGH_WATER_MARK = 100;
/** Inbound QoS 2 exchanges a client may hold open, advertised in the v5 CONNACK. */
export const RECEIVE_MAXIMUM = 1000;
/** Past this many receipts kept for a session, more are not kept: a replay resends those deliveries instead. */
const RECEIVED_LIMIT = 1000;
let _DurableSession: any;
function getDurableSession() {
	if (!_DurableSession) {
		_DurableSession = table({
			database: 'system',
			table: 'hdb_durable_session',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{
					name: 'subscriptions',
					type: 'array',
				},
				{
					name: 'awaitingAcks',
					type: 'array',
				},
				{ name: 'awaitingRelease', type: 'array' },
				{ name: 'awaitingCompletion', type: 'array' },
				{ name: 'incarnation', type: 'string' },
			],
		});
	}
	return _DurableSession;
}
let _LastWill: any;
/**
 * A scoped token's only revocation is expiry, so its will must not publish past it. Keyed off the
 * persisted will principal (not any live session user) so both will paths agree on one source.
 * Fails closed: a scoped will with no recorded expiry is treated as expired rather than published.
 */
function isWillFromExpiredScopedToken(will: any): boolean {
	const user = will?.user;
	if (!user?._scopedToken) return false;
	return !user.authExpiresAt || user.authExpiresAt * 1000 <= Date.now();
}

function isPastBearerExpiry(willUser: any): boolean {
	const exp = willUser?.authExpiresAt;
	return typeof exp === 'number' && exp * 1000 <= Date.now();
}

/** Drops the runtime-only pre-expanded operations Set so the permission set is storage-safe. */
function stripRuntimePermissionState(permission: any): any {
	if (!permission || typeof permission !== 'object') return permission;
	const { _expandedOperations, ...durable } = permission;
	return durable;
}

function getLastWill() {
	if (!_LastWill) {
		_LastWill = table({
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
	}
	return _LastWill;
}
if (getWorkerIndex() === 0) {
	(async () => {
		await whenComponentsLoaded;
		await new Promise((resolve) => setTimeout(resolve, 2000));
		for await (const will of getLastWill().search({})) {
			try {
				await replayLastWill(will);
			} catch {
				// One will's publish/delete failure must not abort replay of the rest; the row stays and
				// is retried on the next restart.
				warn('Failed to publish will', will.data);
			}
		}
	})();
}

export async function replayLastWill(will: any): Promise<void> {
	const data = will.data;
	const message = { ...will };
	if (message.user?._scopedToken) {
		// A scoped token's username is attribution only; never rehydrate it by name (that could
		// substitute a real principal). The will carries the token's own downgraded role.
		if (!isWillFromExpiredScopedToken(message)) {
			await publishMessage(message, data, message);
		} else warn('Dropping will from an expired scoped token', data);
	} else if (isPastBearerExpiry(message.user)) {
		warn('Dropping will from an expired bearer token', data);
	} else {
		const persistedUser = message.user;
		if (persistedUser?.username) message.user = await (server as any).getUser(persistedUser.username);
		// the lookup can outlast a bearer token
		if (isPastBearerExpiry(persistedUser)) warn('Dropping will from an expired bearer token', data);
		else await publishMessage(message, data, message);
	}
	await getLastWill().delete(will.id);
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
	properties,
	will,
	keepalive,
}: {
	clientId;
	user;
	listener: Function;
	clean?: boolean;
	properties?: any;
	will: any;
	keepalive?: number;
}) {
	let session;
	if (properties?.sessionExpiryInterval > 0) nonDurable = false;
	if (sessionId && !nonDurable) {
		let sessionResource = await getDurableSession().get(sessionId, { returnNonexistent: true });
		if (sessionResource && !sessionRecordResumable(sessionResource)) {
			warn(`Resetting MQTT session ${sessionId}: a subscription's position can no longer resume here`);
			try {
				await getDurableSession().delete(sessionId);
			} catch (error) {
				error.code ??= 0x80;
				throw error;
			}
			sessionResource = undefined;
		}
		session = new DurableSubscriptionsSession(sessionId, user, sessionResource);
		if (sessionResource) {
			session.sessionWasPresent = true;
			await session.takeOver();
		}
	} else {
		if (sessionId) {
			// connecting with a clean session and session id is how durable sessions are deleted
			const sessionResource = await getDurableSession().get(sessionId);
			if (sessionResource) await getDurableSession().delete(sessionId);
		}
		session = new SubscriptionsSession(sessionId, user);
	}
	if (will) {
		// keyed by connection, so a connection that is closing can never publish or delete a newer one's will
		will.id = [sessionId, session.incarnation];
		// A scoped-token bearer's will must carry the token's own role and expiry: its username is
		// attribution only and cannot be rehydrated from hdb_user at replay time. Persist only the
		// durable permission fields — not the runtime-only _expandedOperations Set, which is rebuilt
		// on read and would not round-trip through storage.
		will.user = user?._scopedToken
			? {
					username: user.username,
					_scopedToken: true,
					authExpiresAt: user.authExpiresAt,
					role: user.role && {
						role: user.role.role,
						id: user.role.id,
						permission: stripRuntimePermissionState(user.role.permission),
					},
				}
			: user?._bearerValidator
				? { username: user.username, authExpiresAt: user.authExpiresAt }
				: { username: user?.username };
		// Must be durably persisted before CONNACK is sent (getSession() resolving is what lets
		// mqtt.ts send CONNACK). Otherwise a client that connects and then disconnects abruptly
		// (no DISCONNECT packet) can race ahead of this write: SubscriptionsSession.disconnect()
		// reads this same record back to publish the will, finds nothing, and silently drops it.
		await getLastWill().put(will);
		session.willId = will.id;
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
const MAX_MESSAGE_ID = 65500;
let nextMessageId = 1;
function getNextMessageId() {
	nextMessageId++;
	// MQTT only supports 16-bit message ids, so must roll over before getting beyond 16-bit ids.
	if (nextMessageId > MAX_MESSAGE_ID) nextMessageId = 1;
	return nextMessageId;
}
type Acknowledgement = {
	qos?: number;
	topic?: string;
	timestamp?: number;
	acknowledge?: () => any;
};
type InboundExchange = {
	reply: Promise<any>;
	published?: boolean;
	acknowledgement?: any;
	/** Its save failed, so a retransmission tries it again. */
	unsaved?: boolean;
	release?: Promise<boolean>;
};
const ALREADY_RECEIVED = -1;
const MESSAGE_IDS_EXHAUSTED = 'MESSAGE_IDS_EXHAUSTED';

class SubscriptionsSession {
	listener: (topic, message, messageId, subscription, version?, dup?: boolean) => any;
	sessionId: any;
	user: any;
	request: any;
	socket: any;
	subscriptions = [];
	awaitingAcks: Map<number, Acknowledgement>;
	/** Kept until the PUBREL's removal is saved. */
	awaitingRelease: Map<number, InboundExchange>;
	/** Each settles once its PUBREL may be sent. */
	awaitingCompletion: Map<number, Promise<boolean> | boolean>;
	sessionWasPresent: boolean;
	keepalive: number;
	keepaliveTimer: any;
	terminated = false;
	incarnation = randomBytes(8).toString('hex');
	willId: [string, string] | undefined;
	/** Closes the transport; mqtt.ts supplies it, and sends a v5 DISCONNECT carrying `error` first. */
	closeConnection?: (error?: Error) => void;
	constructor(sessionId, user) {
		this.sessionId = sessionId;
		this.user = user;
	}
	consumed(_subscription) {}
	subscribed(_subscription) {}
	subscriptionFailed(subscription, error) {
		if (this.terminated || subscription.failed) return;
		subscription.failed = true;
		warn(`MQTT subscription to ${subscription.topic ?? 'a topic'} ended`, error);
		this.terminated = true;
		this.closeConnection?.(error);
	}
	async addSubscription(subscriptionRequest, needsAck, filter?) {
		const { topic, rh: retainHandling, startTime } = subscriptionRequest;
		const searchIndex = topic.indexOf('?');
		let path;
		if (searchIndex > -1) {
			path = topic.slice(0, searchIndex);
		} else path = topic;
		if (!path) throw new Error('No topic provided');
		if (path.indexOf('.') > -1) throw new Error('Dots are not allowed in topic names');
		// might be faster to somehow modify existing subscription and re-get the retained record, but this should work for now
		const existingSubscription = this.subscriptions.find((subscription) => subscription.topic === topic);
		let omitCurrent = subscriptionRequest.omitCurrent === true;
		if (existingSubscription) {
			omitCurrent ||= retainHandling > 0;
			existingSubscription.end();
			this.subscriptions.splice(this.subscriptions.indexOf(existingSubscription), 1);
		} else {
			omitCurrent ||= retainHandling === 2;
		}
		if (startTime) trace('Resuming subscription from', topic, 'from', startTime);
		const entry = resources.getMatch(path, 'mqtt');
		if (!entry) {
			const notFoundError = new Error(
				`The topic ${topic} does not exist, no resource has been defined to handle this topic`
			);
			(notFoundError as any).statusCode = 404;
			throw notFoundError;
		}
		let url = entry.relativeURL;
		let isCollection;
		let onlyChildren;
		let hashIndex: number;
		if (url.indexOf('+') > -1 || (hashIndex = url.indexOf('#')) > -1) {
			const path = url.slice(1); // remove leading slash
			hashIndex--; // adjust accordingly
			if (hashIndex > -1 && hashIndex !== path.length - 1)
				throw new Error('Multi-level wildcards can only be used at the end of a topic');
			// treat as a collection to get all children, but we will need to filter out any that are not direct children or matching the pattern
			isCollection = true; // used by Resource to determine if the resource should be treated as a collection
			if (path.indexOf('+') === path.length - 1) {
				// if it is only a trailing single-level wildcard, we can treat it as a shallow wildcard
				// and use the optimized onlyChildren option, which will be faster, and does not require any filtering
				onlyChildren = true;
				url = '/' + path.slice(0, path.length - 1);
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
				url = '/' + (firstWildcard > -1 ? matchingPath.slice(0, firstWildcard) : matchingPath).concat('').join('/');
			}
		} else isCollection = false; // must explicitly turn this off so topics that end in a slash are not treated as collections
		const request = new RequestTarget(url);
		Object.assign(request, {
			// bind parameterised path segments (e.g. :id, *rest) first, so a route param can never override a
			// framework-controlled field below — most importantly checkPermission (matches REST.ts / publishMessage)
			...entry.params,
			isCollection,
			onlyChildren,
			startTime,
			omitCurrent,
			databaseGeneration: subscriptionRequest.databaseGeneration,
			reportProgress: subscriptionRequest.reportProgress,
			resume: subscriptionRequest.resume,
			filterKey: subscriptionRequest.filterKey,
			includeSuperseded: this instanceof DurableSubscriptionsSession && subscriptionRequest.qos > 0 ? true : undefined,
			checkPermission: this.user?.role?.permission ?? {},
		});
		const resourcePath = entry.path;
		const resource = entry.Resource;
		const context = this.createContext();
		context.topic = topic;
		context.retainHandling = retainHandling;
		context.isCollection = request.isCollection;
		const subscription = await transaction(context, async () => {
			const subscription = await resource.subscribe(request, context);
			if (!subscription) {
				return; // if no subscription, nothing to return
			}
			if (!subscription[Symbol.asyncIterator])
				throw new Error(`Subscription is not (async) iterable for topic ${topic}`);
			if (this.terminated) {
				subscription.end?.();
				return;
			}
			subscription.topic = topic;
			subscription.qos = subscriptionRequest.qos;
			this.subscribed(subscription);
			// a consumer blocked on socket back-pressure would not reach a final error for a long time
			subscription.on?.('close', () => {
				if (subscription.closedWith instanceof Error) this.subscriptionFailed(subscription, subscription.closedWith);
			});
			const _result = (async () => {
				for await (const update of subscription) {
					try {
						if (update instanceof Error) {
							this.subscriptionFailed(subscription, update);
							break;
						}
						if (!update || typeof update !== 'object') continue;
						let messageId;
						let dup = false;
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
							const priorMessageId = subscriptionRequest.qos === 2 ? this.priorDelivery(update) : undefined;
							if (priorMessageId === ALREADY_RECEIVED) {
								update.acknowledge?.();
								continue;
							}
							messageId = this.needsAcknowledge(update, subscriptionRequest.qos, priorMessageId);
							dup = priorMessageId !== undefined;
						} else {
							// There is no ack to wait for. We can immediately notify any interested source
							// that we have sent the message
							update.acknowledge?.();
							messageId = getNextMessageId();
						}
						let path = update.id;
						if (Array.isArray(path)) path = keyArrayToString(path);
						if (path == null) path = '';
						// the version is forwarded so the delivery side can tell a store-sourced event (whose
						// value is a fresh object per version) from an app-yielded one that may be a reused
						// mutable envelope — only the former is safe to encode once and share
						const result = await this.listener(
							resourcePath + '/' + path,
							update.value,
							messageId,
							subscriptionRequest,
							update.version,
							dup
						);
						if (result === false) break;
						const pending = this.pendingDeliveries();
						if (pending > AWAITING_ACKS_HIGH_WATER_MARK) {
							// slow it down if we are getting too far ahead in acks
							await new Promise((resolve) => setTimeout(resolve, pending - AWAITING_ACKS_HIGH_WATER_MARK));
						} else await new Promise(setImmediate); // yield event turn
					} catch (error) {
						if (error.code === MESSAGE_IDS_EXHAUSTED) {
							this.subscriptionFailed(subscription, error);
							break;
						}
						warn(error);
					} finally {
						this.consumed(subscription);
					}
				}
			})();
			_result.catch((error) => this.subscriptionFailed(subscription, error));
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
	newMessageId() {
		for (let attempt = 0; attempt < MAX_MESSAGE_ID; attempt++) {
			const messageId = getNextMessageId();
			if (!this.messageIdInUse(messageId)) return messageId;
		}
		const error: any = new Error(`Every MQTT packet identifier is in flight for session ${this.sessionId}`);
		error.code = MESSAGE_IDS_EXHAUSTED;
		throw error;
	}
	messageIdInUse(messageId: number): boolean {
		return this.awaitingAcks?.has(messageId) || this.awaitingCompletion?.has(messageId);
	}
	pendingDeliveries(): number {
		return (this.awaitingAcks?.size ?? 0) + (this.awaitingCompletion?.size ?? 0);
	}
	priorDelivery(_update): number | undefined {
		return undefined;
	}
	needsAcknowledge(update, qos: number, messageId = this.newMessageId()) {
		if (update.acknowledge || qos === 2) {
			if (!this.awaitingAcks) this.awaitingAcks = new Map();
			this.awaitingAcks.set(messageId, { qos, acknowledge: update.acknowledge });
		}
		return messageId;
	}
	acknowledge(messageId) {
		const acknowledgement = this.awaitingAcks?.get(messageId);
		if (acknowledgement) {
			this.awaitingAcks.delete(messageId);
			acknowledgement.acknowledge?.();
		}
	}
	/**
	 * Until its PUBREL, a QoS 2 PUBLISH with a packet id already received is a retransmission: it gets
	 * the first one's PUBREC, once that is saved, and is not published again.
	 */
	receiveExactlyOnce(messageId: number, publish: () => Promise<any>) {
		const exchanges = (this.awaitingRelease ??= new Map());
		const known = exchanges.get(messageId);
		if (known?.unsaved) {
			known.unsaved = false;
			known.reply = this.saveExchange(known);
		}
		if (known) return known.reply;
		if (exchanges.size >= RECEIVE_MAXIMUM) {
			const error: any = new Error(`MQTT client ${this.sessionId} exceeded its Receive Maximum of ${RECEIVE_MAXIMUM}`);
			error.mqttReasonCode = 0x93;
			return Promise.reject(error);
		}
		const exchange: InboundExchange = { reply: undefined };
		exchange.reply = publish().then(
			async (acknowledgement) => {
				if (acknowledgement.reasonCode >= 0x80) {
					// a failed PUBLISH ends its exchange at the PUBREC, so a retry publishes
					if (exchanges.get(messageId) === exchange) exchanges.delete(messageId);
					return acknowledgement;
				}
				exchange.published = true;
				exchange.acknowledgement = acknowledgement;
				return this.saveExchange(exchange);
			},
			(error) => {
				if (exchanges.get(messageId) === exchange) exchanges.delete(messageId);
				throw error;
			}
		);
		exchanges.set(messageId, exchange);
		return exchange.reply;
	}
	async saveExchange(exchange: InboundExchange) {
		try {
			await this.saveExchanges();
		} catch (error) {
			exchange.unsaved = true;
			throw error;
		}
		return exchange.acknowledgement;
	}
	/** The client may reuse the id once it has the PUBCOMP, so the removal is saved first. */
	release(messageId: number): Promise<boolean> | boolean {
		const exchange = this.awaitingRelease?.get(messageId);
		if (!exchange) return false;
		exchange.release ??= (async () => {
			try {
				await exchange.reply;
				await this.saveExchanges();
			} catch (error) {
				// kept in the next save, and a retransmitted PUBREL tries again
				exchange.release = undefined;
				throw error;
			}
			if (this.awaitingRelease.get(messageId) === exchange) this.awaitingRelease.delete(messageId);
			return true;
		})();
		return exchange.release;
	}
	received(messageId: number, failed: boolean): Promise<boolean> | boolean {
		const owed = this.awaitingCompletion?.get(messageId);
		if (owed !== undefined) return owed;
		if (this.awaitingAcks?.get(messageId)?.qos !== 2) return false;
		this.acknowledge(messageId);
		if (!failed) (this.awaitingCompletion ??= new Map()).set(messageId, true);
		return true;
	}
	completed(messageId: number) {
		this.awaitingCompletion?.delete(messageId);
	}
	saveExchanges(): Promise<void> | void {}
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
		return publishMessage(message, data, this.createContext());
	}
	createContext(): any {
		const context: any = {
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
	setListener(listener: (topic, message, messageId, subscription, version?, dup?: boolean) => any) {
		this.listener = listener;
	}
	disconnect(clientTerminated) {
		if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
		const willId = this.willId;
		this.willId = undefined;
		if (willId) {
			this.settleWill(willId, !clientTerminated).catch((error) => {
				warn(`Error publishing MQTT will for ${this.sessionId}`, error);
			});
		}

		for (const subscription of this.subscriptions) {
			subscription.end();
		}
		this.subscriptions = [];
	}
	/** The will row is session bookkeeping on contexts of its own; only the publish runs as the session (server/DESIGN.md). */
	async settleWill(willId: [string, string], publish: boolean) {
		try {
			if (publish) {
				const will = await getLastWill().get(willId, {});
				if (will && !isWillFromExpiredScopedToken(will) && !isPastBearerExpiry(will.user)) {
					const context = this.createContext();
					// A scoped will authorizes under its own embedded role, never the disconnecting
					// session's user (which may be a later same-clientId reconnect).
					if (will.user?._scopedToken) context.user = will.user;
					await publishMessage(will, will.data, context);
				}
			}
		} finally {
			await getLastWill().delete(willId, {});
		}
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
async function publishMessage(message: any, data: any, context: any) {
	const { topic, retain } = message;
	message = { ...message, data, async: true };
	context.authorize = true;
	const entry = resources.getMatch(topic, 'mqtt');
	if (!entry) {
		// Typed like addSubscription's identical miss, so a protocol layer can map it to a specific
		// code rather than a generic failure.
		const notFoundError: any = new Error(
			`Can not publish to topic ${topic} as it does not exist, no resource has been defined to handle this topic`
		);
		notFoundError.statusCode = 404;
		throw notFoundError;
	}
	message.url = entry.relativeURL;
	const target = new RequestTarget(entry.relativeURL);
	if (entry.params) Object.assign(target, entry.params); // bind parameterised path segments (e.g. :id, *rest)
	target.checkPermission = context.user?.role?.permission ?? {};

	const resource = entry.Resource;

	return transaction(context, () => {
		return retain
			? data === undefined
				? resource.delete(target, context)
				: resource.put(target, message.data, context)
			: resource.publish(target, message.data, context);
	});
}
/**
 * A delivery is identified by its log key, its ordinal among the deliveries sharing that key (a
 * transaction's events share one, and a record can recur in it), and its record id as a check.
 */
type DeliveryIdentity = [key: number, ordinal: number, id: unknown];
/** A QoS 0 entry has no position: QoS 0 promises no delivery while the client is away, so it resumes live. */
type DurableEntry = {
	qos: number;
	topic: string;
	startTime?: number;
	databaseGeneration?: string;
	/** QoS 2 deliveries above `startTime` that the client has taken (PUBREC), which a replay skips. */
	received?: DeliveryIdentity[];
	/** `[key, count]`: the first `count` deliveries sharing `key`, taken in order, kept as one entry. */
	receivedRuns?: [number, number][];
	/** Every delivery with a key above `startTime` and at or below this was taken. */
	receivedThrough?: number;
	/**
	 * QoS 2 deliveries sent and not yet PUBREC'd, with their packet ids, which a replay sends again as DUPs; with a
	 * checkpoint, each names its origin so a resume on another node can hold that origin's boundary.
	 */
	inFlight?: [...DeliveryIdentity, number, string?][];
	/** The database generation whose log keys the receipts and in-flight deliveries name. */
	receiptsGeneration?: string;
	/**
	 * The per-origin checkpoint, kept beside the scalar position an older reader resumes from.
	 * Once established it is never replaced by the scalar: it stops advancing while floors are unavailable, and a
	 * resume it can no longer satisfy resets the session (410).
	 */
	checkpoint?: SubscriptionCheckpoint;
};
function deliveryId(id: unknown) {
	if (Array.isArray(id)) return keyArrayToString(id);
	if (id instanceof Uint8Array) return Buffer.from(id).toString('base64');
	return id ?? null;
}
const slotOf = (key: number, ordinal: number) => key + '/' + ordinal;
type TopicState = {
	entry: DurableEntry;
	subscription?: any;
	/** False while a resumed replay awaits its verdict; nothing is checkpointed past the resumed position until then. */
	verified: boolean;
	deliveredKey?: number;
	keyBefore?: number;
	highestKey?: number;
	/** Each event has its own log key, as on LMDB; a RocksDB transaction's events share one. */
	keysPerEntry?: boolean;
	/** In delivery order: `needsAcknowledge` is its only writer and runs as each message is sent. */
	unacked: Map<
		number,
		{ key: number; ordinal: number; id: unknown; previousKey?: number; late?: boolean; origin?: number }
	>;
	received?: Map<string, DeliveryIdentity>;
	receivedRuns?: Map<number, number>;
	receivedThrough?: number;
	resend?: Map<string, [...DeliveryIdentity, number, string?]>;
	ordinalKey?: number;
	ordinal: number;
	/** Unacked deliveries that arrived below a key delivered before them. */
	lateUnacked: number;
	consumed: number;
	currentCheckpoint?: SubscriptionCheckpoint;
	checkpointComputedAt?: number;
};

/** Only pruned history resets a session: a position from another generation resumes unchecked instead. */
const RESETTING_REFUSALS = new Set(['RESUME_HISTORY_UNAVAILABLE']);

const KEY_SCRATCH = new Float64Array(1);
const KEY_BITS = new BigInt64Array(KEY_SCRATCH.buffer);
/** The greatest double below a log key, so a replay after it starts at the key. */
function positionBefore(key: number): number {
	if (key === 0) return -Number.MIN_VALUE;
	// doubles of one sign order by their bit patterns, read as signed integers
	KEY_SCRATCH[0] = key;
	KEY_BITS[0] += key > 0 ? -1n : 1n;
	return KEY_SCRATCH[0];
}

function logKeysPerEntry(topic: string): boolean {
	const auditStore = resources.getMatch(topic.split('?')[0], 'mqtt')?.Resource?.auditStore;
	return Boolean(auditStore) && !auditStore.reusableIterable;
}

function checkpointInterval(): number {
	return Math.min(auditRetention / 10, 3_600_000);
}

/**
 * Whether every collection entry can still resume from its position, checked from metadata against
 * the floor before CONNACK. A record's own history walk decides the rest after CONNACK, and a resource
 * that is not a table is left to its own subscribe.
 */
function sessionRecordResumable(record: any): boolean {
	for (const entry of record.subscriptions || []) {
		const match = resources.getMatch(entry.topic.split('?')[0], 'mqtt');
		// a checkpoint names origin keys, so it is checked here whichever node issued it, record topics too
		if (entry.checkpoint !== undefined && !checkpointAdmissible(match?.Resource, entry.checkpoint)) return false;
		if (!/[+#]/.test(match?.relativeURL ?? '')) continue;
		if (!boundToCurrentGeneration(entry)) continue;
		if (!isResumablePosition(match.Resource.auditStore, entry.databaseGeneration, entry.startTime)) return false;
	}
	return true;
}

/** Only a 410 refuses before CONNACK; a malformed or re-scoped checkpoint falls back to the scalar after it. */
function checkpointAdmissible(Resource: any, checkpoint: unknown): boolean {
	if (!Resource?.auditStore || !Resource.dbisDB) return true;
	try {
		admitCheckpoint(Resource.auditStore, Resource.dbisDB, validateCheckpoint(checkpoint));
		return true;
	} catch (error) {
		return error?.statusCode !== 410;
	}
}

/** The lowest key the checkpoint certifies everything below: the common boundary, or the lowest exception. */
function checkpointFloor(checkpoint: SubscriptionCheckpoint): number {
	let floor = checkpoint.time - checkpoint.overlap;
	for (const boundary of Object.values(checkpoint.exceptions)) if (boundary < floor) floor = boundary;
	return floor;
}

function auditStoreOf(topic: string): any {
	return resources.getMatch(topic.split('?')[0], 'mqtt')?.Resource?.auditStore;
}

function originNameOf(topic: string, origin: number | undefined): string | undefined {
	if (origin === undefined) return;
	if (origin === 0) return getThisNodeName();
	const auditStore = auditStoreOf(topic);
	return auditStore ? getNodeNameForId(auditStore, origin, true) : undefined;
}

/**
 * Only a position from the database's current generation can be checked. One from another node's
 * generation (the record replicates), or from before a restore or copy, resumes unchecked instead.
 */
function currentGeneration(topic: string): string | undefined {
	const auditStore = resources.getMatch(topic.split('?')[0], 'mqtt')?.Resource?.auditStore;
	return auditStore ? getDatabaseGeneration(auditStore)?.id : undefined;
}

function boundToCurrentGeneration(entry: DurableEntry): boolean {
	if (entry.databaseGeneration === undefined) return false;
	const auditStore = resources.getMatch(entry.topic.split('?')[0], 'mqtt')?.Resource?.auditStore;
	return Boolean(auditStore) && getDatabaseGeneration(auditStore)?.id === entry.databaseGeneration;
}

export class DurableSubscriptionsSession extends SubscriptionsSession {
	committed: Promise<void> | void;
	/** Only a session that found no record may create one; any other updates only a record it owns. */
	mayCreate: boolean;
	discarded = false;
	/** An ended session saves nothing after its final save, so it cannot overwrite a newer connection's record. */
	sealed = false;
	topics = new Map<string, TopicState>();
	/** Settles once the latest save or deletion has, and never rejects. */
	writes: Promise<void> = Promise.resolve();
	saving: Promise<void> | undefined;
	dirty = false;
	checkpointScheduled: Promise<void> | undefined;
	checkpointTimer: any;
	/** Packets are handled concurrently, so SUBSCRIBE, UNSUBSCRIBE and resume change `topics` one at a time. */
	changes: Promise<unknown> = Promise.resolve();
	reservedIds = new Set<number>();
	receivedCount = 0;
	inFlightChanged = false;
	/** Bumped per `advancePositions`, so each topic computes its checkpoint once per pass. */
	advanceCount = 0;
	/** Set while the final save waits for inbound publishes; `sealed` follows once it is taken. */
	sealing = false;
	savesStarted = 0;
	saveWaiters: { needed: number; resolve: () => void; reject: (error: Error) => void }[] = [];
	constructor(sessionId, user, record?) {
		super(sessionId, user);
		this.mayCreate = !record;
		for (const messageId of record?.awaitingRelease || []) {
			(this.awaitingRelease ??= new Map()).set(messageId, {
				reply: Promise.resolve({ cmd: 'pubrec', messageId, reasonCode: 0 }),
				published: true,
			});
		}
		for (const messageId of record?.awaitingCompletion || []) {
			(this.awaitingCompletion ??= new Map()).set(messageId, true);
		}
		for (const entry of record?.subscriptions || []) {
			const { qos, topic, startTime, databaseGeneration, checkpoint } = entry;
			const state = newTopicState(
				qos > 0
					? {
							qos,
							topic,
							startTime,
							databaseGeneration: boundToCurrentGeneration(entry) ? databaseGeneration : undefined,
							checkpoint,
						}
					: { qos, topic }
			);
			// keys from another node's log, or from before a restore or copy, name nothing here; receipts kept with
			// a checkpoint name origin keys, which are the same on every node
			if (entry.receiptsGeneration === currentGeneration(topic) || checkpoint !== undefined) {
				state.receivedThrough = entry.receivedThrough;
				for (const [key, count] of entry.receivedRuns || []) {
					(state.receivedRuns ??= new Map()).set(key, count);
					this.receivedCount++;
				}
				for (const identity of entry.received || []) this.addReceived(state, identity);
				for (const delivery of entry.inFlight || []) {
					(state.resend ??= new Map()).set(slotOf(delivery[0], delivery[1]), delivery);
					this.reservedIds.add(delivery[3]);
				}
			}
			this.topics.set(topic, state);
		}
	}
	/** Claim the record for this connection before CONNACK, so an older connection's writes stop. */
	async takeOver() {
		await getDurableSession().put(this.recordToWrite(), { source: true });
	}
	inOrder<T>(change: () => Promise<T>): Promise<T> {
		const result = this.changes.then(change);
		this.changes = result.catch(() => {});
		return result;
	}
	resume() {
		return this.inOrder(() => this.resumeTopics());
	}
	async resumeTopics() {
		if (this.topics.size > 0) this.startCheckpoints();
		for (const state of [...this.topics.values()]) {
			if (this.terminated) return;
			const { qos, topic, startTime, databaseGeneration, checkpoint } = state.entry;
			const durable = qos > 0;
			try {
				if (durable && checkpoint !== undefined) {
					try {
						await this.resumeSubscription(
							{ topic, qos, rh: 2, resume: checkpoint, filterKey: topic, reportProgress: true },
							durable
						);
						continue;
					} catch (error) {
						// a checkpoint for another scope (the table was recreated) resumes from the scalar it kept
						if (error?.statusCode !== 409 && error?.statusCode !== 400) throw error;
						warn(
							`Durable session ${this.sessionId} resumes ${topic} from its position; its checkpoint was refused: ${error.message}`
						);
						delete state.entry.checkpoint;
						this.dropForeignReceipts(state);
						if (this.terminated) return;
					}
				}
				await this.resumeSubscription(
					durable
						? { topic, qos, rh: 2, startTime, databaseGeneration, reportProgress: true, filterKey: topic }
						: { topic, qos, rh: 2 },
					durable
				);
			} catch (error) {
				this.subscriptionFailed({ topic }, error);
				return;
			}
		}
	}
	resumeSubscription(subscription, needsAck, filter?) {
		return super.addSubscription(subscription, needsAck, filter);
	}
	subscribed(subscription) {
		let state = this.topics.get(subscription.topic);
		if (!(subscription.qos > 0)) {
			if (state) this.forgetTopic(state);
			state = newTopicState({ qos: 0, topic: subscription.topic });
			state.subscription = subscription;
			this.topics.set(subscription.topic, state);
			return;
		}
		if (!state || !(state.entry.qos > 0)) {
			const startTime = subscription.registeredThrough ?? getNextMonotonicTime();
			const databaseGeneration =
				subscription.registeredThrough === undefined ? undefined : subscription.databaseGeneration;
			state = newTopicState({ qos: subscription.qos, topic: subscription.topic, startTime, databaseGeneration });
			this.topics.set(subscription.topic, state);
		} else if (state.subscription) {
			const replaced = state;
			state = newTopicState({ ...state.entry, qos: subscription.qos });
			this.topics.set(subscription.topic, state);
			if (subscription.qos === 2) {
				state.received = replaced.received;
				state.receivedRuns = replaced.receivedRuns;
				state.receivedThrough = replaced.receivedThrough;
				state.resend = replaced.resend;
				// the replacement replays from the position, so a delivery still awaiting its PUBREC keeps its id
				for (const [messageId, sent] of replaced.unacked) {
					if (this.awaitingAcks?.get(messageId)?.qos !== 2) continue;
					const originName = originNameOf(subscription.topic, sent.origin);
					(state.resend ??= new Map()).set(
						slotOf(sent.key, sent.ordinal),
						originName === undefined
							? [sent.key, sent.ordinal, sent.id, messageId]
							: [sent.key, sent.ordinal, sent.id, messageId, originName]
					);
					this.reservedIds.add(messageId);
				}
			} else this.forgetTopic(replaced);
		}
		state.subscription = subscription;
		if (subscription.progress === undefined) state.keysPerEntry = logKeysPerEntry(subscription.topic);
		if (subscription.resumeVerified) {
			state.verified = false;
			subscription.resumeVerified
				.then((verified) => {
					if (!verified || state.subscription !== subscription) return;
					state.verified = true;
					this.scheduleCheckpoint();
				})
				.catch((error) => warn(error));
		} else if (state.entry.databaseGeneration !== undefined && subscription.progress === undefined) {
			// the resource did not check the position, so the entry no longer claims a checked one
			state.entry.databaseGeneration = undefined;
		}
	}
	messageIdInUse(messageId: number): boolean {
		return super.messageIdInUse(messageId) || this.reservedIds.has(messageId);
	}
	addReceived(state: TopicState, identity: DeliveryIdentity) {
		const [key, ordinal] = identity;
		const runs = (state.receivedRuns ??= new Map());
		let run = runs.get(key) ?? 0;
		if (ordinal < run) return;
		if (ordinal === run) {
			if (run === 0) {
				if (this.receivedCount >= RECEIVED_LIMIT) return;
				this.receivedCount++;
			}
			run++;
			while (state.received?.delete(slotOf(key, run))) {
				this.receivedCount--;
				run++;
			}
			runs.set(key, run);
			return;
		}
		const slot = slotOf(key, ordinal);
		if (!state.received?.has(slot)) {
			if (this.receivedCount >= RECEIVED_LIMIT) return;
			this.receivedCount++;
		}
		(state.received ??= new Map()).set(slot, identity);
	}
	forgetTopic(state: TopicState) {
		this.receivedCount -= (state.received?.size ?? 0) + (state.receivedRuns?.size ?? 0);
		for (const delivery of state.resend?.values() ?? []) this.reservedIds.delete(delivery[3]);
	}
	priorDelivery(update) {
		const state = this.topics.get(update.topic);
		if (state?.entry.qos !== 2 || update.fromScan || typeof update.localTime !== 'number') return;
		const key = update.localTime;
		// a transaction's events arrive together and in the same order when replayed
		if (key === state.ordinalKey) state.ordinal++;
		else {
			state.ordinalKey = key;
			state.ordinal = 0;
		}
		if (
			!state.received?.size &&
			!state.resend?.size &&
			!state.receivedRuns?.size &&
			state.receivedThrough === undefined
		)
			return;
		const slot = slotOf(key, state.ordinal);
		const id = deliveryId(update.id);
		const resend = state.resend?.get(slot);
		if (resend?.[2] === id) {
			state.resend.delete(slot);
			this.reservedIds.delete(resend[3]);
			return resend[3];
		}
		// a live transaction that commits below what was delivered before it is new, not a replay
		if (key <= state.receivedThrough && !(key < state.highestKey)) return ALREADY_RECEIVED;
		if (state.ordinal < (state.receivedRuns?.get(key) ?? 0)) return ALREADY_RECEIVED;
		if (state.received?.get(slot)?.[2] === id) return ALREADY_RECEIVED;
	}
	/**
	 * Every key below the deliveries still awaiting PUBREC, and below the last delivered key (whose
	 * transaction may have more queued), was taken whole, so its entries collapse into `receivedThrough`.
	 */
	compactReceived(state: TopicState, checkpointFloor?: number) {
		let bound = state.deliveredKey;
		if (bound === undefined) return;
		if (state.entry.checkpoint !== undefined) {
			// an origin can commit below the scalar watermark but never below its own certified floor, which the
			// checkpoint's lowest boundary is at or below; without a current checkpoint nothing is compacted
			const floor = checkpointFloor ?? state.subscription?.checkpointFloor?.();
			if (floor === undefined) return;
			if (floor < bound) bound = floor;
		} else {
			// a transaction that took a key below the delivered ones can still commit until progress passes it
			const progress = state.subscription?.progress?.();
			if (progress !== undefined && progress < bound) bound = progress;
		}
		for (const { key } of state.unacked.values()) {
			if (key < bound) bound = key;
			// with none late, the oldest unacknowledged delivery has the lowest key
			if (state.lateUnacked === 0) break;
		}
		for (const [key] of state.resend?.values() ?? []) if (key < bound) bound = key;
		let through = state.receivedThrough;
		for (const key of state.receivedRuns?.keys() ?? []) {
			if (key >= bound) continue;
			if (!(through >= key)) through = key;
			state.receivedRuns.delete(key);
			this.receivedCount--;
		}
		for (const [slot, [key]] of state.received ?? []) {
			if (key >= bound) continue;
			if (!(through >= key)) through = key;
			state.received.delete(slot);
			this.receivedCount--;
		}
		state.receivedThrough = through;
	}
	needsAcknowledge(update, qos: number, messageId = this.newMessageId()) {
		if (!this.awaitingAcks) this.awaitingAcks = new Map();
		const ackInfo: Acknowledgement = {
			qos,
			topic: update.topic,
			timestamp: update.localTime,
		};
		if (update.acknowledge) ackInfo.acknowledge = update.acknowledge;
		this.awaitingAcks.set(messageId, ackInfo);
		const state = this.topics.get(update.topic);
		// scan deliveries are state, not history: their keys follow no transaction order
		if (state && !update.fromScan && typeof update.localTime === 'number') {
			const key = update.localTime;
			if (key !== state.deliveredKey) {
				// a transaction can commit after one with a higher key, so it arrives below the last delivered key
				state.keyBefore = key < state.deliveredKey ? positionBefore(key) : state.deliveredKey;
				state.deliveredKey = key;
			}
			if (qos === 2) this.inFlightChanged = true;
			const late = key < state.highestKey;
			if (late) state.lateUnacked++;
			else state.highestKey = key;
			state.unacked.set(messageId, {
				key,
				ordinal: state.ordinal,
				id: qos === 2 ? deliveryId(update.id) : undefined,
				previousKey: state.keyBefore,
				late,
				origin: typeof update[ORIGIN_ID] === 'number' ? update[ORIGIN_ID] : undefined,
			});
		}
		return messageId;
	}
	acknowledge(messageId) {
		const update = this.awaitingAcks?.get(messageId);
		if (!update) return;
		this.awaitingAcks.delete(messageId);
		update.acknowledge?.();
		const state = this.topics.get(update.topic);
		if (state?.unacked.get(messageId)?.late) state.lateUnacked--;
		state?.unacked.delete(messageId);
		// mqtt.ts reports the acknowledgement once this settles, so what it allows is saved by then
		return this.scheduleCheckpoint();
	}
	/** Its PUBREL waits for a save that keeps the message from being sent again and records the PUBREL owed. */
	received(messageId: number, failed: boolean) {
		const owed = this.awaitingCompletion?.get(messageId);
		// false: its save failed, so a repeated PUBREC tries it again
		if (owed === false) return this.owePubrel(messageId);
		if (owed !== undefined) return owed;
		const delivery = this.awaitingAcks?.get(messageId);
		if (delivery?.qos !== 2) return false;
		const state = this.topics.get(delivery.topic);
		const sent = state?.unacked.get(messageId);
		let identity: DeliveryIdentity | undefined = sent && [sent.key, sent.ordinal, sent.id];
		if (!sent && state) {
			// sent by a subscription this one replaced, and not yet sent again
			for (const [slot, resend] of state.resend ?? []) {
				if (resend[3] !== messageId) continue;
				state.resend.delete(slot);
				this.reservedIds.delete(messageId);
				identity = [resend[0], resend[1], resend[2]];
				break;
			}
		}
		this.dirty = true;
		this.acknowledge(messageId);
		if (state) {
			// compacted first, so the receipt limit counts only what is still kept; the boundary vector built here
			// is the one the position advance below reuses
			this.advanceCount++;
			const checkpoint = state.entry.checkpoint === undefined ? undefined : this.currentCheckpoint(state);
			const floor = checkpoint === undefined ? undefined : checkpointFloor(checkpoint);
			this.compactReceived(state, floor);
			// the position cannot pass it while an older delivery, or the rest of its transaction, is unacknowledged
			if (identity) {
				this.addReceived(state, identity);
				this.compactReceived(state, floor);
			}
		}
		if (failed) return true;
		this.advancePositions(false);
		return this.owePubrel(messageId);
	}
	owePubrel(messageId: number) {
		const awaitingCompletion = (this.awaitingCompletion ??= new Map());
		// in the map before the save starts, which reads it at once
		awaitingCompletion.set(messageId, true);
		const saved = this.saveExchanges().then(
			() => true,
			(error) => {
				if (awaitingCompletion.get(messageId) === saved) awaitingCompletion.set(messageId, false);
				throw error;
			}
		);
		awaitingCompletion.set(messageId, saved);
		return saved;
	}
	completed(messageId: number) {
		// one not yet saved only has its PUBREL sent again after a reconnect, which the client completes again
		if (this.awaitingCompletion?.delete(messageId)) {
			this.dirty = true;
			this.scheduleCheckpoint();
		}
	}
	receiveExactlyOnce(messageId: number, publish: () => Promise<any>) {
		if (this.terminated) return Promise.reject(this.endedError());
		return super.receiveExactlyOnce(messageId, publish);
	}
	/** Settles once a save that read the session after this call has landed: later saves are not waited for. */
	saveExchanges(): Promise<void> {
		// an ended session's last save has been taken, so nothing it would acknowledge can be kept
		if (this.sealed || this.discarded) return Promise.reject(this.endedError());
		const needed = this.savesStarted + 1;
		return new Promise((resolve, reject) => {
			this.saveWaiters.push({ needed, resolve, reject });
			this.persist().catch(() => {});
		});
	}
	/** The final save waits for inbound QoS 2 publishes still committing, so it keeps their ids; nothing saves after it. */
	seal(save: boolean) {
		if (this.sealing || this.sealed) return;
		const publishing = [];
		for (const exchange of this.awaitingRelease?.values() ?? []) {
			// bounded within the takeover deadline: one that misses it is saved as not published, so a retransmission publishes
			if (!exchange.published && !exchange.release)
				publishing.push(Promise.race([exchange.reply.catch(() => {}), sealWait()]));
		}
		if (publishing.length === 0) {
			if (save) this.persist().catch(() => {});
			this.sealed = true;
			return;
		}
		// a takeover waits on `writes`, so it reads the record only after this save
		this.sealing = true;
		this.writes = Promise.all([this.writes, ...publishing]).then(() => {
			const saved = this.persist().catch(() => {});
			this.sealed = true;
			return saved;
		});
	}
	hasInFlight() {
		for (const state of this.topics.values()) if (state.entry.qos === 2 && state.unacked.size > 0) return true;
		return false;
	}
	consumed(subscription) {
		const state = this.topics.get(subscription.topic);
		if (state?.subscription === subscription) state.consumed++;
	}
	addSubscription(subscription, needsAck) {
		return this.inOrder(() => this.subscribeTopic(subscription, needsAck));
	}
	async subscribeTopic(subscription, needsAck) {
		const { topic } = subscription;
		const durable = subscription.qos > 0;
		const existing = this.topics.get(topic);
		const replaced = existing?.subscription;
		let request = subscription;
		if (durable) {
			request = { ...subscription, reportProgress: true, filterKey: topic };
			if (existing?.entry.qos > 0) {
				// replacing a subscription must lose nothing, so the new one continues the topic's position
				this.advancePositions();
				if (existing.entry.checkpoint !== undefined) request.resume = existing.entry.checkpoint;
				else {
					request.startTime = existing.entry.startTime;
					if (boundToCurrentGeneration(existing.entry)) request.databaseGeneration = existing.entry.databaseGeneration;
				}
			}
		}
		let started;
		try {
			if (request.resume !== undefined) {
				try {
					started = await this.resumeSubscription(request, needsAck);
				} catch (error) {
					if (error?.statusCode !== 409 && error?.statusCode !== 400) throw error;
					// another scope, or LMDB: continue from the scalar the topic kept, as a resume does
					warn(
						`Durable session ${this.sessionId} continues ${topic} from its position; its checkpoint was refused: ${error.message}`
					);
					delete existing.entry.checkpoint;
					this.dropForeignReceipts(existing);
					if (this.terminated) throw error;
					delete request.resume;
					request.startTime = existing.entry.startTime;
					if (boundToCurrentGeneration(existing.entry)) request.databaseGeneration = existing.entry.databaseGeneration;
					started = await this.resumeSubscription(request, needsAck);
				}
			} else started = await this.resumeSubscription(request, needsAck);
			if (durable) this.startCheckpoints();
			if (durable || started) await this.persist();
		} catch (error) {
			// a continued position that can no longer resume resets the session, as it would at reconnect
			if (RESETTING_REFUSALS.has(error?.code)) this.subscriptionFailed({ topic }, error);
			// the client is told this SUBSCRIBE failed, so it must not keep receiving or come back saved
			else this.dropFailedSubscription(topic, started, replaced);
			throw error;
		}
		return subscription;
	}
	/** Replacing ends the old subscription before the new one can fail, so a failed SUBSCRIBE leaves its topic unsubscribed. */
	dropFailedSubscription(topic, started, replaced) {
		const index = started ? this.subscriptions.indexOf(started) : -1;
		if (index > -1) {
			started.end();
			this.subscriptions.splice(index, 1);
		}
		const owner = this.topics.get(topic)?.subscription;
		if (owner && (owner === started || (owner === replaced && !this.subscriptions.includes(owner)))) {
			this.forgetTopic(this.topics.get(topic));
			this.topics.delete(topic);
			this.persist().catch(() => {});
		}
	}
	removeSubscription(topic) {
		return this.inOrder(async () => {
			const result = await super.removeSubscription(topic);
			const state = this.topics.get(topic);
			if (state) this.forgetTopic(state);
			const saved = this.topics.delete(topic);
			// a retry after a failed save reports that save, not a removal already made in memory
			if (saved || this.dirty || this.saving) await this.persist();
			return result || saved;
		});
	}
	saveSubscriptions() {
		return this.persist();
	}
	/**
	 * The newest position this topic can resume from with nothing it has delivered and not been acked
	 * after it: `progress()` bounds what the subscription has sent, and every unacked delivery bounds
	 * what the client has taken. A transaction's deliveries share its key, so an unacked one holds the
	 * position before its whole transaction.
	 */
	nextPosition(state: TopicState): number | undefined {
		const subscription = state.subscription;
		if (!subscription || !state.verified) return;
		// a resource that certifies nothing (LMDB, or not a table) advances on acknowledgements alone
		const certified = subscription.progress !== undefined;
		// a message still queued can share the last delivered key, unless every event has its own
		let boundary = certified
			? subscription.sentCount === state.consumed
				? Infinity
				: state.keyBefore
			: state.keysPerEntry
				? state.deliveredKey
				: state.keyBefore;
		for (const { previousKey } of state.unacked.values()) {
			if (previousKey === undefined) return;
			if (previousKey < boundary) boundary = previousKey;
			// with none late, every unacked key is at or above the oldest's, so the oldest's bound holds for all
			if (state.lateUnacked === 0) break;
		}
		if (boundary === undefined || !certified) return boundary;
		const progress = subscription.progress();
		if (progress === undefined) return;
		return boundary < progress ? boundary : progress;
	}
	/** `fresh`: false reuses the checkpoints a `received` computed for this pass. */
	advancePositions(fresh = true): boolean {
		let changed = false;
		if (fresh) this.advanceCount++;
		for (const state of this.topics.values()) {
			if (!(state.entry.qos > 0)) continue;
			const next = this.nextPosition(state);
			if (next === undefined) continue;
			const bound = state.entry.databaseGeneration !== undefined;
			// an unbound start came from a clock, so a certified position replaces it rather than racing it
			if (bound && !(next > state.entry.startTime)) continue;
			if (!bound && next === state.entry.startTime) continue;
			state.entry.startTime = next;
			// a checkpoint resume replays from its boundaries, below which a remote origin can sit under the scalar:
			// once floors certify a boundary, nothing above it is pruned, from the very call that establishes the token
			if (state.entry.checkpoint === undefined) {
				const checkpoint = this.currentCheckpoint(state);
				this.pruneReceipts(
					state,
					checkpoint === undefined ? next : Math.min(next, positionBefore(checkpointFloor(checkpoint)))
				);
			}
			// only a certified position may be checked on resume
			state.entry.databaseGeneration =
				state.subscription.progress === undefined ? undefined : state.subscription.databaseGeneration;
			changed = true;
		}
		for (const state of this.topics.values()) {
			if (!(state.entry.qos > 0)) continue;
			const checkpoint = this.currentCheckpoint(state);
			if (!checkpoint || sameCheckpoint(checkpoint, state.entry.checkpoint)) continue;
			// the scalar watermark was compacted against a position an origin can commit below; from the first
			// checkpoint on, receipts are bounded by its floor only
			if (state.entry.checkpoint === undefined) state.receivedThrough = undefined;
			state.entry.checkpoint = checkpoint;
			this.pruneReceipts(state, positionBefore(checkpointFloor(checkpoint)));
			changed = true;
		}
		return changed;
	}
	/** The checkpoint the topic's subscription certifies now, computed once per `advancePositions` pass. */
	currentCheckpoint(state: TopicState): SubscriptionCheckpoint | undefined {
		if (state.checkpointComputedAt === this.advanceCount) return state.currentCheckpoint;
		state.checkpointComputedAt = this.advanceCount;
		state.currentCheckpoint = undefined;
		if (!state.verified || !state.subscription?.checkpoint) return;
		const holds = this.holdsOf(state);
		if (holds) state.currentCheckpoint = state.subscription.checkpoint(holds);
		return state.currentCheckpoint;
	}
	/** Drops receipts and resends at or below `through`, which no replay from this topic's position reaches. */
	pruneReceipts(state: TopicState, through: number) {
		for (const [slot, [key]] of state.received ?? []) {
			if (key <= through) {
				state.received.delete(slot);
				this.receivedCount--;
			}
		}
		if (state.receivedThrough <= through) state.receivedThrough = undefined;
		for (const key of state.receivedRuns?.keys() ?? []) {
			if (key <= through) {
				state.receivedRuns.delete(key);
				this.receivedCount--;
			}
		}
		for (const [slot, delivery] of state.resend ?? []) {
			if (delivery[0] <= through) {
				state.resend.delete(slot);
				this.reservedIds.delete(delivery[3]);
			}
		}
	}
	/** Receipts kept for a checkpoint name origin keys that a scalar replay in this generation may not. */
	dropForeignReceipts(state: TopicState) {
		if (state.entry.databaseGeneration !== undefined) return;
		this.receivedCount -= (state.received?.size ?? 0) + (state.receivedRuns?.size ?? 0);
		state.received = undefined;
		state.receivedRuns = undefined;
		state.receivedThrough = undefined;
	}
	/**
	 * The lowest key per origin among deliveries the client has not taken, which hold that origin's boundary;
	 * undefined when a delivery's origin is unknown (restored by a build that did not record it), so the
	 * checkpoint keeps its last value.
	 */
	holdsOf(state: TopicState): Map<number, number> | undefined {
		const holds = new Map<number, number>();
		for (const { key, origin } of state.unacked.values()) {
			if (origin === undefined) return;
			if (!(holds.get(origin) <= key)) holds.set(origin, key);
		}
		if (state.resend?.size) {
			const thisNodeName = getThisNodeName();
			const nameToId = exportIdMapping(auditStoreOf(state.entry.topic)) ?? {};
			for (const delivery of state.resend.values()) {
				const name = delivery[4];
				const origin = name === undefined ? undefined : name === thisNodeName ? 0 : nameToId[name];
				if (typeof origin !== 'number') return;
				if (!(holds.get(origin) <= delivery[0])) holds.set(origin, delivery[0]);
			}
		}
		return holds;
	}
	/** Settles once the scheduled checkpoint's save has, and never rejects. */
	scheduleCheckpoint(): Promise<void> {
		if (this.terminated) return Promise.resolve();
		this.checkpointScheduled ??= new Promise<void>((resolve) =>
			setImmediate(() => {
				this.checkpointScheduled = undefined;
				this.checkpoint();
				resolve(this.writes);
			})
		);
		return this.checkpointScheduled;
	}
	checkpoint() {
		if (this.terminated) return;
		if (this.advancePositions() || this.dirty || this.inFlightChanged) this.persist().catch(() => {});
	}
	startCheckpoints() {
		if (this.checkpointTimer || this.terminated) return;
		this.checkpointTimer = setInterval(() => this.checkpoint(), checkpointInterval());
		this.checkpointTimer.unref?.();
	}
	recordToWrite() {
		const subscriptions = [];
		this.inFlightChanged = false;
		for (const state of this.topics.values()) {
			const { qos, topic, startTime, databaseGeneration } = state.entry;
			const saved: DurableEntry = { qos, topic };
			if (startTime !== undefined) saved.startTime = startTime;
			if (databaseGeneration !== undefined) saved.databaseGeneration = databaseGeneration;
			if (state.received?.size > 0) saved.received = [...state.received.values()];
			if (state.receivedRuns?.size > 0) saved.receivedRuns = [...state.receivedRuns];
			if (state.receivedThrough !== undefined) saved.receivedThrough = state.receivedThrough;
			if (qos === 2) {
				const inFlight: [...DeliveryIdentity, number, string?][] = [...(state.resend?.values() ?? [])];
				for (const [messageId, { key, ordinal, id, origin }] of state.unacked) {
					const originName = originNameOf(topic, origin);
					inFlight.push(
						originName === undefined ? [key, ordinal, id, messageId] : [key, ordinal, id, messageId, originName]
					);
				}
				if (inFlight.length > 0) saved.inFlight = inFlight;
			}
			if (saved.received || saved.receivedRuns || saved.receivedThrough !== undefined || saved.inFlight)
				saved.receiptsGeneration = currentGeneration(topic);
			if (state.entry.checkpoint !== undefined) saved.checkpoint = state.entry.checkpoint;
			subscriptions.push(saved);
		}
		const record: any = { id: this.sessionId, incarnation: this.incarnation, subscriptions };
		const awaitingRelease = [];
		for (const [messageId, exchange] of this.awaitingRelease ?? []) {
			// one still publishing must publish again if retransmitted, and one being released is gone once saved
			if (exchange.published && !exchange.release) awaitingRelease.push(messageId);
		}
		if (awaitingRelease.length > 0) record.awaitingRelease = awaitingRelease;
		if (this.awaitingCompletion?.size > 0) record.awaitingCompletion = [...this.awaitingCompletion.keys()];
		return record;
	}
	persist(): Promise<void> {
		if (this.sealed) return this.writes;
		this.dirty = true;
		if (this.discarded) return Promise.resolve();
		if (!this.saving) {
			this.saving = this.saveWhileDirty();
			const writes = this.saving.catch((error) => warn(`Failed to save MQTT session ${this.sessionId}`, error));
			// while sealing, `writes` is the final save a takeover waits on, which joins this one
			if (!this.sealing) this.writes = writes;
		}
		return this.saving;
	}
	async saveWhileDirty() {
		let failure: Error | undefined;
		try {
			while (this.dirty && !this.discarded) {
				this.dirty = false;
				await this.saveOnce();
			}
		} catch (error) {
			failure = error;
			// the next checkpoint retries
			this.dirty = true;
			this.startCheckpoints();
			throw error;
		} finally {
			// cleared with the last dirty check, so a later persist() starts a new save rather than joining this one
			this.saving = undefined;
			// a waiter is left only when no save will run for it
			if (this.saveWaiters.length > 0) this.settleSaveWaiters(Infinity, failure ?? this.endedError());
		}
	}
	async saveOnce() {
		const saveNumber = ++this.savesStarted;
		const record = this.recordToWrite();
		try {
			const stored = await getDurableSession().get(this.sessionId);
			if (this.discarded) return this.settleSaveWaiters(saveNumber, this.endedError());
			if (stored ? stored.incarnation !== this.incarnation : !this.mayCreate) {
				this.settleSaveWaiters(saveNumber, this.endedError());
				return this.supersede();
			}
			await getDurableSession().put(record, { source: true });
		} catch (error) {
			this.settleSaveWaiters(saveNumber, error);
			throw error;
		}
		this.mayCreate = false;
		this.settleSaveWaiters(saveNumber);
	}
	endedError() {
		return new Error(`MQTT session ${this.sessionId} has ended`);
	}
	settleSaveWaiters(saveNumber: number, error?: Error) {
		if (this.saveWaiters.length === 0) return;
		const waiting = [];
		for (const waiter of this.saveWaiters) {
			if (waiter.needed > saveNumber) waiting.push(waiter);
			else if (error) waiter.reject(error);
			else waiter.resolve();
		}
		this.saveWaiters = waiting;
	}
	/** Hands the session to a newer connection on this thread: its positions are saved, in `writes`, and it saves nothing after. */
	yieldTo() {
		if (!this.terminated) {
			const changed = this.advancePositions();
			this.terminated = true;
			clearInterval(this.checkpointTimer);
			this.seal(changed || this.dirty || this.hasInFlight());
			this.closeConnection?.();
		} else this.seal(false);
	}
	supersede() {
		if (this.terminated) return;
		this.terminated = true;
		// the record is another connection's now, or a clean start deleted it
		this.discarded = true;
		clearInterval(this.checkpointTimer);
		this.closeConnection?.();
	}
	subscriptionFailed(subscription, error) {
		if (this.terminated || subscription.failed) return;
		subscription.failed = true;
		clearInterval(this.checkpointTimer);
		if (!RESETTING_REFUSALS.has(error?.code)) {
			// the client can reconnect and resume from what this session saves now
			this.advancePositions();
			this.persist().catch(() => {});
			this.terminated = true;
			warn(`Closing MQTT session ${this.sessionId}: its subscription to ${subscription.topic} failed`, error);
			try {
				this.closeConnection?.(error);
			} catch (closeError) {
				warn(closeError);
			}
			return;
		}
		this.discarded = true;
		this.terminated = true;
		warn(`Resetting MQTT session ${this.sessionId}: ${error.message}`);
		for (const other of this.subscriptions) other.end();
		this.subscriptions = [];
		try {
			this.closeConnection?.(error);
		} catch (closeError) {
			warn(closeError);
		}
		const deletion = (this.saving ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const stored = await getDurableSession().get(this.sessionId);
				if (stored?.incarnation === this.incarnation) await getDurableSession().delete(this.sessionId);
			});
		this.writes = deletion.catch((deleteError) =>
			warn(`Failed to delete the reset MQTT session ${this.sessionId}`, deleteError)
		);
	}
	disconnect(clientTerminated) {
		clearInterval(this.checkpointTimer);
		// ending a subscription clears its queue, which would read as idle, so positions are taken first
		const changed = !this.terminated && this.advancePositions();
		this.terminated = true;
		super.disconnect(clientTerminated);
		// a SUBSCRIBE still in flight would otherwise save after a reconnect has claimed the record
		this.seal((changed || this.dirty || this.hasInFlight()) && !this.discarded);
	}
}

const SEAL_WAIT = 5_000;
function sealWait() {
	return new Promise<void>((resolve) => setTimeout(resolve, SEAL_WAIT).unref());
}

function sameCheckpoint(a: SubscriptionCheckpoint, b: SubscriptionCheckpoint | undefined): boolean {
	if (!b) return false;
	if (a.time !== b.time || a.overlap !== b.overlap || a.members !== b.members || a.scope !== b.scope) return false;
	const names = Object.keys(a.exceptions);
	if (names.length !== Object.keys(b.exceptions).length) return false;
	for (const name of names) if (a.exceptions[name] !== b.exceptions[name]) return false;
	return true;
}

function newTopicState(entry: DurableEntry): TopicState {
	return {
		entry,
		verified: true,
		unacked: new Map(),
		ordinal: 0,
		lateUnacked: 0,
		consumed: 0,
	};
}
