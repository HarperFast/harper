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

const AWAITING_ACKS_HIGH_WATER_MARK = 100;
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
			const data = will.data;
			const message = { ...will };
			try {
				if (message.user?._scopedToken) {
					// A scoped token's username is attribution only; never rehydrate it by name (that could
					// substitute a real principal). The will carries the token's own downgraded role.
					if (!isWillFromExpiredScopedToken(message)) {
						await publishMessage(message, data, message);
					} else warn('Dropping will from an expired scoped token', data);
				} else {
					if (message.user?.username) message.user = await (server as any).getUser(message.user.username);
					await publishMessage(message, data, message);
				}
				await getLastWill().delete(will.id);
			} catch {
				// One will's publish/delete failure must not abort replay of the rest; the row stays and
				// is retried on the next restart.
				warn('Failed to publish will', data);
			}
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
			if (sessionResource) getDurableSession().delete(sessionId);
		}
		session = new SubscriptionsSession(sessionId, user);
	}
	if (will) {
		will.id = sessionId;
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
			: { username: user?.username };
		// Must be durably persisted before CONNACK is sent (getSession() resolving is what lets
		// mqtt.ts send CONNACK). Otherwise a client that connects and then disconnects abruptly
		// (no DISCONNECT packet) can race ahead of this write: SubscriptionsSession.disconnect()
		// reads this same record back to publish the will, finds nothing, and silently drops it.
		await getLastWill().put(will);
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
	listener: (topic, message, messageId, subscription, version?) => any;
	sessionId: any;
	user: any;
	request: any;
	socket: any;
	subscriptions = [];
	awaitingAcks: Map<number, Acknowledgement>;
	sessionWasPresent: boolean;
	keepalive: number;
	keepaliveTimer: any;
	terminated = false;
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
		let omitCurrent;
		if (existingSubscription) {
			omitCurrent = retainHandling > 0;
			existingSubscription.end();
			this.subscriptions.splice(this.subscriptions.indexOf(existingSubscription), 1);
		} else {
			omitCurrent = retainHandling === 2;
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
						// the version is forwarded so the delivery side can tell a store-sourced event (whose
						// value is a fresh object per version) from an app-yielded one that may be a reused
						// mutable envelope — only the former is safe to encode once and share
						const result = await this.listener(
							resourcePath + '/' + path,
							update.value,
							messageId,
							subscriptionRequest,
							update.version
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
	setListener(listener: (topic, message, messageId, subscription, version?) => any) {
		this.listener = listener;
	}
	disconnect(clientTerminated) {
		if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
		const context = this.createContext();
		transaction(context, async () => {
			try {
				if (!clientTerminated) {
					const will = await getLastWill().get(this.sessionId);
					if (will && !isWillFromExpiredScopedToken(will)) {
						// A scoped will authorizes under its own embedded role, never the disconnecting
						// session's user (which may be a later same-clientId reconnect).
						const willContext = will.user?._scopedToken ? { ...context, user: will.user } : context;
						await publishMessage(will, will.data, willContext);
					}
				}
			} finally {
				await getLastWill().delete(this.sessionId);
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
/** A QoS 0 entry has no position: QoS 0 promises no delivery while the client is away, so it resumes live. */
type DurableEntry = { qos: number; topic: string; startTime?: number; databaseGeneration?: string };
type TopicState = {
	entry: DurableEntry;
	subscription?: any;
	/** False while a resumed replay awaits its verdict; nothing is checkpointed past the resumed position until then. */
	verified: boolean;
	deliveredKey?: number;
	keyBefore?: number;
	/** Each event has its own log key, as on LMDB; a RocksDB transaction's events share one. */
	keysPerEntry?: boolean;
	unacked: Map<number, { key: number; previousKey?: number }>;
	consumed: number;
};

const RESUME_REFUSALS = new Set(['DATABASE_GENERATION_CHANGED', 'RESUME_HISTORY_UNAVAILABLE']);

function logKeysPerEntry(topic: string): boolean {
	const auditStore = resources.getMatch(topic.split('?')[0], 'mqtt')?.Resource?.auditStore;
	return Boolean(auditStore) && !auditStore.reusableIterable;
}

function checkpointInterval(): number {
	return Math.min(auditRetention / 10, 3_600_000);
}

/**
 * Whether every generation-bound entry can still resume, checked from metadata before CONNACK. A
 * collection is checked against the floor too; a record's own history walk decides the rest after
 * CONNACK, and a resource that is not a table is left to its own subscribe.
 */
function sessionRecordResumable(record: any): boolean {
	for (const entry of record.subscriptions || []) {
		if (entry.databaseGeneration === undefined) continue;
		const match = resources.getMatch(entry.topic.split('?')[0], 'mqtt');
		const auditStore = match?.Resource?.auditStore;
		if (!auditStore) continue;
		const collection = /[+#]/.test(match.relativeURL ?? '');
		const resumable = collection
			? isResumablePosition(auditStore, entry.databaseGeneration, entry.startTime)
			: getDatabaseGeneration(auditStore)?.id === entry.databaseGeneration;
		if (!resumable) return false;
	}
	return true;
}

export class DurableSubscriptionsSession extends SubscriptionsSession {
	committed: Promise<void> | void;
	incarnation = randomBytes(8).toString('hex');
	/** Only a session that found no record may create one; any other updates only a record it owns. */
	mayCreate: boolean;
	discarded = false;
	topics = new Map<string, TopicState>();
	/** Settles once the latest save or deletion has, and never rejects. */
	writes: Promise<void> = Promise.resolve();
	saving: Promise<void> | undefined;
	dirty = false;
	checkpointScheduled = false;
	checkpointTimer: any;
	/** Packets are handled concurrently, so SUBSCRIBE, UNSUBSCRIBE and resume change `topics` one at a time. */
	changes: Promise<unknown> = Promise.resolve();
	constructor(sessionId, user, record?) {
		super(sessionId, user);
		this.mayCreate = !record;
		for (const { qos, topic, startTime, databaseGeneration } of record?.subscriptions || []) {
			this.topics.set(topic, newTopicState(qos > 0 ? { qos, topic, startTime, databaseGeneration } : { qos, topic }));
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
			const { qos, topic, startTime, databaseGeneration } = state.entry;
			const durable = qos > 0;
			try {
				// retain handling, not omitCurrent, decides whether a subscription starts with current values
				await this.resumeSubscription(
					durable
						? { omitCurrent: true, topic, qos, startTime, databaseGeneration, reportProgress: true }
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
			state = newTopicState({ qos: 0, topic: subscription.topic });
			state.subscription = subscription;
			this.topics.set(subscription.topic, state);
			return;
		}
		if (!state || state.subscription || !(state.entry.qos > 0)) {
			const startTime = subscription.registeredThrough ?? getNextMonotonicTime();
			const databaseGeneration =
				subscription.registeredThrough === undefined ? undefined : subscription.databaseGeneration;
			state = newTopicState({ qos: subscription.qos, topic: subscription.topic, startTime, databaseGeneration });
			this.topics.set(subscription.topic, state);
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
	needsAcknowledge(update) {
		if (!this.awaitingAcks) this.awaitingAcks = new Map();
		const messageId = getNextMessageId();
		const ackInfo: Acknowledgement = {
			topic: update.topic,
			timestamp: update.localTime,
		};
		if (update.acknowledge) ackInfo.acknowledge = update.acknowledge;
		this.awaitingAcks.set(messageId, ackInfo);
		const state = this.topics.get(update.topic);
		// scan deliveries are state, not history: their keys follow no transaction order
		if (state && !update.fromScan && typeof update.localTime === 'number') {
			if (update.localTime !== state.deliveredKey) {
				state.keyBefore = state.deliveredKey;
				state.deliveredKey = update.localTime;
			}
			state.unacked.set(messageId, { key: update.localTime, previousKey: state.keyBefore });
		}
		return messageId;
	}
	acknowledge(messageId) {
		const update = this.awaitingAcks?.get(messageId);
		if (!update) return;
		this.awaitingAcks.delete(messageId);
		update.acknowledge?.();
		this.topics.get(update.topic)?.unacked.delete(messageId);
		this.scheduleCheckpoint();
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
		const replaced = this.topics.get(topic)?.subscription;
		let started;
		try {
			started = await this.resumeSubscription(
				durable ? { ...subscription, reportProgress: true } : subscription,
				needsAck
			);
			if (durable) {
				this.startCheckpoints();
				await this.persist();
			} else if (started) {
				// a QoS 0 subscription promises no delivery, so a failed save need not refuse it
				this.persist().catch(() => {});
			}
		} catch (error) {
			// the client is told this SUBSCRIBE failed, so it must not keep receiving or come back saved
			this.dropFailedSubscription(topic, started, replaced);
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
			this.topics.delete(topic);
			this.persist().catch(() => {});
		}
	}
	removeSubscription(topic) {
		return this.inOrder(async () => {
			const result = await super.removeSubscription(topic);
			if (this.topics.delete(topic)) await this.persist();
			return result;
		});
	}
	saveSubscriptions() {
		return this.persist();
	}
	/**
	 * The newest position this topic can resume from with nothing it has delivered and not been acked
	 * after it: `progress()` bounds what the subscription has sent, and the oldest unacked delivery bounds
	 * what the client has taken. A transaction's deliveries share its key, so an unacked one holds the
	 * position before its whole transaction.
	 */
	nextPosition(state: TopicState): number | undefined {
		const subscription = state.subscription;
		if (!subscription || !state.verified) return;
		const oldestUnacked = state.unacked.values().next();
		if (subscription.progress === undefined) {
			// a resource that certifies nothing (LMDB, or not a table) advances on acknowledgements alone
			if (!oldestUnacked.done) return oldestUnacked.value.previousKey;
			// a message still queued can share the last delivered key, unless every event has its own
			return state.keysPerEntry ? state.deliveredKey : state.keyBefore;
		}
		const progress = subscription.progress();
		if (progress === undefined) return;
		const boundary = !oldestUnacked.done
			? oldestUnacked.value.previousKey
			: subscription.sentCount === state.consumed
				? Infinity
				: state.keyBefore;
		if (boundary === undefined) return;
		return boundary < progress ? boundary : progress;
	}
	advancePositions(): boolean {
		let changed = false;
		for (const state of this.topics.values()) {
			if (!(state.entry.qos > 0)) continue;
			const next = this.nextPosition(state);
			if (next === undefined) continue;
			const bound = state.entry.databaseGeneration !== undefined;
			// an unbound start came from a clock, so a certified position replaces it rather than racing it
			if (bound && !(next > state.entry.startTime)) continue;
			if (!bound && next === state.entry.startTime) continue;
			state.entry.startTime = next;
			// only a certified position may be checked on resume
			state.entry.databaseGeneration =
				state.subscription.progress === undefined ? undefined : state.subscription.databaseGeneration;
			changed = true;
		}
		return changed;
	}
	scheduleCheckpoint() {
		if (this.checkpointScheduled || this.terminated) return;
		this.checkpointScheduled = true;
		setImmediate(() => {
			this.checkpointScheduled = false;
			this.checkpoint();
		});
	}
	checkpoint() {
		if (this.terminated) return;
		if (this.advancePositions() || this.dirty) this.persist().catch(() => {});
	}
	startCheckpoints() {
		if (this.checkpointTimer) return;
		this.checkpointTimer = setInterval(() => this.checkpoint(), checkpointInterval());
		this.checkpointTimer.unref?.();
	}
	recordToWrite() {
		const subscriptions = [];
		for (const { entry } of this.topics.values()) {
			const { qos, topic, startTime, databaseGeneration } = entry;
			const saved: DurableEntry = { qos, topic };
			if (startTime !== undefined) saved.startTime = startTime;
			if (databaseGeneration !== undefined) saved.databaseGeneration = databaseGeneration;
			subscriptions.push(saved);
		}
		return { id: this.sessionId, incarnation: this.incarnation, subscriptions };
	}
	persist(): Promise<void> {
		this.dirty = true;
		if (this.discarded) return Promise.resolve();
		if (!this.saving) {
			this.saving = this.saveWhileDirty();
			this.writes = this.saving.catch((error) => warn(`Failed to save MQTT session ${this.sessionId}`, error));
		}
		return this.saving;
	}
	async saveWhileDirty() {
		try {
			while (this.dirty && !this.discarded) {
				this.dirty = false;
				await this.saveOnce();
			}
		} catch (error) {
			// the next checkpoint retries
			this.dirty = true;
			throw error;
		} finally {
			// cleared with the last dirty check, so a later persist() starts a new save rather than joining this one
			this.saving = undefined;
		}
	}
	async saveOnce() {
		const record = this.recordToWrite();
		const stored = await getDurableSession().get(this.sessionId);
		if (stored ? stored.incarnation !== this.incarnation : !this.mayCreate) return this.supersede();
		await getDurableSession().put(record, { source: true });
		this.mayCreate = false;
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
		if (!RESUME_REFUSALS.has(error?.code)) {
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
		if ((changed || this.dirty) && !this.discarded) this.persist().catch(() => {});
	}
}

function newTopicState(entry: DurableEntry): TopicState {
	return { entry, verified: true, unacked: new Map(), consumed: 0 };
}
