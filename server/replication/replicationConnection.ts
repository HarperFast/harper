import { getDatabases, databases, table as ensureTable, onUpdatedTable, onRemovedDB } from '../../resources/databases';
import {
	createAuditEntry,
	Decoder,
	getLastRemoved,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	REMOTE_SEQUENCE_UPDATE,
	readAuditEntry,
} from '../../resources/auditStore';
import { exportIdMapping, getIdOfRemoteNode, remoteToLocalNodeId } from './nodeIdMapping';
import { whenNextTransaction } from '../../resources/transactionBroadcast';
import {
	replication_certificate_authorities,
	forEachReplicatedDatabase,
	getThisNodeName,
	urlToNodeName,
	getThisNodeId,
	enabled_databases,
	lastTimeInAuditStore,
} from './replicator';
import env from '../../utility/environment/environmentManager';
import { getUpdateRecord, HAS_STRUCTURE_UPDATE } from '../../resources/RecordEncoder';
import { CERT_PREFERENCE_REP } from '../../utility/terms/certificates';
import { decode, encode, Packr, unpackMultiple } from 'msgpackr';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { threadId } from 'worker_threads';
import * as logger from '../../utility/logging/logger';
import { disconnectedFromNode, connectedToNode, ensureNode } from './subscriptionManager';
import { EventEmitter } from 'events';
import { createTLSSelector } from '../../security/keys';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { getHDBNodeTable } from './knownNodes';
import * as process from 'node:process';
import { isIP } from 'node:net';
import { recordAction } from '../../resources/analytics';

// these are the codes we use for the different commands
const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const DISCONNECT = 142;
const RESIDENCY_LIST = 130;
const TABLE_STRUCTURE = 131;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133; // request a specific record
const GET_RECORD_RESPONSE = 134; // request a specific record
export const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const SEQUENCE_ID_UPDATE = 143;
const COMMITTED_UPDATE = 144;
const DB_SCHEMA = 145;
export const table_update_listeners = new Map();
// This a map of the database name to the subscription object, for the subscriptions from our tables to the replication module
// when we receive messages from other nodes, we then forward them on to as a notification on these subscriptions
export const database_subscriptions = new Map();
const DEBUG_MODE = true;
// when we skip messages (usually because we aren't the originating node), we still need to occassionally send a sequence update
// so that catchup occurs more quickly
const SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY = 300;
// The amount time to await after a commit before sending out a committed update (and aggregating all updates).
// We want it be fairly quick so we can let the sending node know that we have received and committed the update.
// (but still allow for batching so we aren't sending out a message for every update under load)
const COMMITTED_UPDATE_DELAY = 2;
const PING_INTERVAL = 30000;
let secure_contexts: Map<string, tls.SecureContext>;
/**
 * Handles reconnection, and requesting catch-up
 */

export async function createWebSocket(
	url,
	options: { authorization?: string; rejectUnauthorized?: boolean; serverName?: string }
) {
	const { authorization, rejectUnauthorized } = options || {};

	const node_name = getThisNodeName();
	let secure_context;
	if (url.includes('wss://')) {
		if (!secure_contexts) {
			const SNICallback = createTLSSelector('operations-api');
			const secure_target = {
				secureContexts: null,
			};
			await SNICallback.initialize(secure_target);
			secure_contexts = secure_target.secureContexts;
		}
		secure_context = secure_contexts.get(node_name);
		if (secure_context) {
			logger.debug?.('Creating web socket for URL', url, 'with certificate named:', secure_context.name);
		}
		if (!secure_context && rejectUnauthorized !== false) {
			throw new Error('Unable to find a valid certificate to use for replication to connect to ' + url);
		}
	}
	const headers = {};
	if (authorization) {
		headers.Authorization = authorization;
	}
	const ws_options = {
		headers,
		localAddress: node_name?.startsWith('127.0') ? node_name : undefined, // this is to make sure we use the correct network interface when doing our local loopback testing
		servername: isIP(options?.serverName) ? undefined : options?.serverName, // use the node name for the SNI negotiation (as long as it is not an IP)
		noDelay: true, // we want to send the data immediately
		// we set this very high (2x times the v22 default) because it performs better
		highWaterMark: 128 * 1024,
		ALPNProtocols: ['http/1.1', 'harperdb-replication'],
		rejectUnauthorized: rejectUnauthorized !== false,
		secureContext: undefined,
	};
	if (secure_context) {
		ws_options.secureContext = tls.createSecureContext({
			...secure_context.options,
			ca: Array.from(replication_certificate_authorities), // do we need to add CA if secure context had one?
		});
	}
	return new WebSocket(url, 'harperdb-replication-v1', ws_options);
}

const INITIAL_RETRY_TIME = 1000;
/**
 * This represents a persistent connection to a node for replication, which handles
 * sockets that may be disconnected and reconnected
 */
export class NodeReplicationConnection extends EventEmitter {
	socket: WebSocket;
	startTime: number;
	retryTime = INITIAL_RETRY_TIME;
	retries = 0;
	isConnected = true; // we start out assuming we will be connected
	isFinished = false;
	nodeSubscriptions = [];
	latency = 0;
	replicateTablesByDefault: boolean;
	session: any; // this is a promise that resolves to the session object, which is the object that handles the replication
	sessionResolve: Function;
	sessionReject: Function;
	nodeName: string;
	constructor(
		public url,
		public subscription,
		public databaseName
	) {
		super();
		this.nodeName = urlToNodeName(url);
	}

	async connect() {
		if (!this.session) this.resetSession();
		const tables = [];
		// TODO: Need to do this specifically for each node
		this.socket = await createWebSocket(this.url, { serverName: this.nodeName });

		let session;
		logger.debug?.(`Connecting to ${this.url}, db: ${this.databaseName}, process ${process.pid}`);
		this.socket.on('open', () => {
			this.socket._socket.unref();
			logger.info?.(`Connected to ${this.url}, db: ${this.databaseName}`);
			this.retries = 0;
			this.retryTime = INITIAL_RETRY_TIME;
			// if we have already connected, we need to send a reconnected event
			connectedToNode({
				name: this.nodeName,
				database: this.databaseName,
				url: this.url,
			});
			this.isConnected = true;
			session = replicateOverWS(
				this.socket,
				{
					database: this.databaseName,
					subscription: this.subscription,
					url: this.url,
					connection: this,
				},
				{ replicates: true } // pre-authorized, but should only make publish: true if we are allowing reverse subscriptions
			);
			this.sessionResolve(session);
		});
		this.socket.on('error', (error) => {
			if (error.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
				logger.warn?.(
					`Can not connect to ${this.url}, this server does not have a certificate authority for the certificate provided by ${this.url}`
				);
				error.isHandled = true;
			} else if (error.code !== 'ECONNREFUSED') {
				if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
					logger.error?.(
						`Can not connect to ${this.url}, the certificate provided by ${this.url} is not trusted, this node needs to be added to the cluster, or a certificate authority needs to be added`
					);
				else logger.error?.(`Error in connection to ${this.url} due to ${error.message}`);
			}
			this.sessionReject(error);
		});
		this.socket.on('close', (code, reason_buffer) => {
			// if we get disconnected, notify subscriptions manager so we can reroute through another node
			if (this.isConnected) {
				disconnectedFromNode({
					name: this.nodeName,
					database: this.databaseName,
					url: this.url,
					finished: this.socket.isFinished,
				});
				this.isConnected = false;
			}

			if (this.socket.isFinished) {
				this.isFinished = true;
				session?.end();
				this.emit('finished');
				return;
			}
			if (++this.retries % 20 === 1) {
				const reason = reason_buffer?.toString();
				logger.warn?.(
					`${session ? 'Disconnected from' : 'Failed to connect to'} ${this.url} (db: "${this.databaseName}"), due to ${
						reason ? '"' + reason + '" ' : ''
					}(code: ${code})`
				);
			}
			session = null;
			this.resetSession();
			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, this.retryTime).unref();
			this.retryTime += this.retryTime >> 3; // increase by 12% each time
		});
	}
	resetSession() {
		this.session = new Promise((resolve, reject) => {
			this.sessionResolve = resolve;
			this.sessionReject = reject;
		});
	}
	subscribe(node_subscriptions, replicate_tables_by_default) {
		this.nodeSubscriptions = node_subscriptions;
		this.replicateTablesByDefault = replicate_tables_by_default;
		this.emit('subscriptions-updated', node_subscriptions);
	}
	unsubscribe() {
		this.socket.isFinished = true;
		this.socket.close(1008, 'No longer subscribed');
	}

	getRecord(request) {
		return this.session.then((session) => {
			return session.getRecord(request);
		});
	}
}

/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
export function replicateOverWS(ws, options, authorization) {
	const p = options.port || options.securePort;
	const connection_id =
		(process.pid % 1000) +
		'-' +
		threadId +
		(p ? 's:' + p : 'c:' + options.url?.slice(-4)) +
		' ' +
		Math.random().toString().slice(2, 3);

	let encoding_start = 0;
	let encoding_buffer = Buffer.allocUnsafeSlow(1024);
	let position = 0;
	let data_view = new DataView(encoding_buffer.buffer, 0, 1024);
	let database_name = options.database;
	const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
	let audit_store;
	let replication_confirmation_float64;
	// this is the subscription that the local table makes to this replicator, and incoming messages
	// are sent to this subscription queue:
	let subscribed = false;
	let table_subscription_to_replicator = options.subscription;
	if (table_subscription_to_replicator?.then)
		table_subscription_to_replicator.then((sub) => (table_subscription_to_replicator = sub));
	let tables = options.tables || (database_name && getDatabases()[database_name]);
	if (!authorization) {
		logger.error?.('No authorization provided');
		// don't send disconnect because we want the client to potentially retry
		close(1008, 'Unauthorized');
		return;
	}
	const awaiting_response = new Map();
	let receiving_data_from_node_ids = [];
	let remote_node_name = authorization.name;
	if (remote_node_name && options.connection) options.connection.nodeName = remote_node_name;
	let last_sequence_id_received, last_sequence_id_committed;
	let send_ping_interval, receive_ping_timer, last_ping_time, skipped_message_sequence_update_timer;
	const DELAY_CLOSE_TIME = 1000;
	let delayed_close: NodeJS.Timeout;
	let last_message_time = 0;
	let last_audit_sent = 0;
	if (options.url) {
		const send_ping = () => {
			if (last_ping_time)
				ws.terminate(); // timeout
			else {
				last_ping_time = performance.now();
				ws.ping();
			}
		};
		send_ping_interval = setInterval(send_ping, PING_INTERVAL).unref();
		send_ping(); // send the first ping immediately so we can measure latency
	} else {
		resetPingTimer();
	}
	function resetPingTimer() {
		clearTimeout(receive_ping_timer);
		receive_ping_timer = setTimeout(() => {
			logger.warn?.(`Timeout waiting for ping from ${remote_node_name}, terminating connection and reconnecting`);
			ws.terminate();
		}, PING_INTERVAL * 2).unref();
	}
	if (database_name) {
		setDatabase(database_name);
	}
	let schema_update_listener, db_removal_listener;
	const table_decoders = [];
	const remote_table_by_id = [];
	let receiving_data_from_node_names;
	const residency_map = [];
	const sent_residency_lists = [];
	const received_residency_lists = [];
	const MAX_OUTSTANDING_COMMITS = 150;
	let outstanding_commits = 0;
	let last_structure_length = 0;
	let replication_paused;
	let subscription_request, audit_subscription;
	let node_subscriptions;
	let remote_short_id_to_local_id: Map<number, number>;
	ws.on('message', (body) => {
		// A replication header should begin with either a transaction timestamp or messagepack message of
		// of an array that begins with the command code
		last_message_time = performance.now();
		try {
			const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
			if (body[0] > 127) {
				// not a transaction, special message
				const message = decode(body);
				const [command, data, table_id] = message;
				switch (command) {
					case NODE_NAME: {
						if (data) {
							// this is the node name
							if (remote_node_name) {
								if (remote_node_name !== data) {
									logger.error?.(
										connection_id,
										`Node name mismatch, expecting to connect to ${remote_node_name}, but peer reported name as ${data}, disconnecting`
									);
									ws.send(encode([DISCONNECT]));
									close(1008, 'Node name mismatch');
									return;
								}
							} else {
								remote_node_name = data;
								if (options.connection?.tentativeNode) {
									// if this was a tentative node, we need to update the node name
									const node_to_add = options.connection.tentativeNode;
									node_to_add.name = remote_node_name;
									options.connection.tentativeNode = null;
									ensureNode(remote_node_name, node_to_add);
								}
							}
							if (options.connection) options.connection.nodeName = remote_node_name;
							//const url = message[3] ?? this_node_url;
							logger.debug?.(connection_id, 'received node name:', remote_node_name, 'db:', database_name);
							if (!database_name) {
								// this means we are the server
								try {
									setDatabase((database_name = message[2]));
									if (database_name === 'system') {
										schema_update_listener = forEachReplicatedDatabase(options, (database, database_name) => {
											if (checkDatabaseAccess(database_name)) sendDBSchema(database_name);
										});
										ws.on('close', () => {
											schema_update_listener?.remove();
										});
									}
								} catch (error) {
									// if this fails, we should close the connection and indicate that we should not reconnect
									logger.warn?.(connection_id, 'Error setting database', error);
									ws.send(encode([DISCONNECT]));
									close(1008, error.message);
									return;
								}
							}
							sendSubscriptionRequestUpdate();
						}
						break;
					}
					case DB_SCHEMA: {
						logger.debug?.(
							connection_id,
							'Received table definitions for',
							data.map((t) => t.table)
						);
						for (const table_definition of data) {
							const database_name = message[2];
							table_definition.database = database_name;
							let table;
							if (checkDatabaseAccess(database_name)) {
								if (database_name === 'system') {
									// for system connection, we only update new tables
									if (!databases[database_name]?.[table_definition.table])
										table = ensureTableIfChanged(table_definition, databases[database_name]?.[table_definition.table]);
								} else {
									table = ensureTableIfChanged(table_definition, databases[database_name]?.[table_definition.table]);
								}
								if (!audit_store) audit_store = table?.auditStore;
								if (!tables) tables = getDatabases()?.[database_name];
							}
						}
						break;
					}
					case DISCONNECT:
						close();
						break;
					case OPERATION_REQUEST:
						try {
							const is_authorized_node = authorization?.replicates || authorization?.subscribers || authorization?.name;
							server.operation(data, { user: authorization }, !is_authorized_node).then(
								(response) => {
									if (Array.isArray(response)) {
										// convert an array to an object so we can have a top-level requestId properly serialized
										response = { results: response };
									}
									response.requestId = data.requestId;
									ws.send(encode([OPERATION_RESPONSE, response]));
								},
								(error) => {
									ws.send(
										encode([
											OPERATION_RESPONSE,
											{
												requestId: data.requestId,
												error: error instanceof Error ? error.toString() : error,
											},
										])
									);
								}
							);
						} catch (error) {
							ws.send(
								encode([
									OPERATION_RESPONSE,
									{
										requestId: data.requestId,
										error: error instanceof Error ? error.toString() : error,
									},
								])
							);
						}
						break;
					case OPERATION_RESPONSE:
						const { resolve, reject } = awaiting_response.get(data.requestId);
						if (data.error) reject(new Error(data.error));
						else resolve(data);
						awaiting_response.delete(data.requestId);
						break;
					case TABLE_FIXED_STRUCTURE:
						const table_name = message[3];
						if (!tables) {
							if (database_name) logger.error?.(connection_id, 'No tables found for', database_name);
							else logger.error?.(connection_id, 'Database name never received');
						}
						let table = tables[table_name];
						table = ensureTableIfChanged(
							{
								table: table_name,
								database: database_name,
								attributes: data.attributes,
								schemaDefined: data.schemaDefined,
							},
							table
						);
						// replication messages come across in binary format of audit log entries from the source node,
						// so we need to have the same structure and decoder configuration to decode them. We keep a map
						// of the table id to the decoder so we can decode the binary data for each table.
						table_decoders[table_id] = {
							name: table_name,
							decoder: new Packr({
								useBigIntExtension: true,
								randomAccessStructure: true,
								freezeData: true,
								typedStructs: data.typedStructs,
								structures: data.structures,
							}),
							getEntry(id) {
								return table.primaryStore.getEntry(id);
							},
							rootStore: table.primaryStore.rootStore,
						};
						break;
					case NODE_NAME_TO_ID_MAP:
						// this is the mapping of node names to short local ids. if there is no audit_store (yet), just make an empty map, but not sure why that would happen.
						remote_short_id_to_local_id = audit_store
							? remoteToLocalNodeId(remote_node_name, data, audit_store)
							: new Map();
						receiving_data_from_node_names = message[2];
						logger.debug?.(
							connection_id,
							`Acknowledged subscription request, receiving messages for nodes: ${receiving_data_from_node_names}`
						);
						break;
					case RESIDENCY_LIST:
						// we need to keep track of the remote node's residency list by id
						const residency_id = table_id;
						received_residency_lists[residency_id] = data;
						break;
					case COMMITTED_UPDATE:
						// we need to record the sequence number that the remote node has received
						const replication_key = ['replicated', database_name, remote_node_name];
						if (!replication_confirmation_float64)
							replication_confirmation_float64 = new Float64Array(
								audit_store.getUserSharedBuffer(replication_key, new ArrayBuffer(8))
							);
						replication_confirmation_float64[0] = data;
						logger.trace?.(connection_id, 'received and broadcasting committed update', data);
						replication_confirmation_float64.buffer.notify();
						break;
					case SEQUENCE_ID_UPDATE:
						// we need to record the sequence number that the remote node has received
						last_sequence_id_received = data;
						table_subscription_to_replicator.send({
							type: 'end_txn',
							localTime: last_sequence_id_received,
							remoteNodeIds: receiving_data_from_node_ids,
						});
						break;
					case GET_RECORD: {
						// this is a request for a record, we need to send it back
						const request_id = data;
						let response_data: Buffer;
						try {
							const record_id = message[3];
							const table = remote_table_by_id[table_id] || (remote_table_by_id[table_id] = tables[message[4]]);
							if (!table) {
								return logger.warn?.('Unknown table id trying to handle record request', table_id);
							}
							// we are sending raw binary data back, so we have to send the typed structure information so the
							// receiving side can properly decode it. We only need to send this once until it changes again, so we can check if the structure
							// has changed. It will only grow, so we can just check the length.
							const structures_binary = table.primaryStore.getBinaryFast(Symbol.for('structures'));
							const structure_length = structures_binary.length;
							if (structure_length !== last_structure_length) {
								last_structure_length = structure_length;
								const structure = decode(structures_binary);
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs: structure.typed,
											structures: structure.named,
										},
										table_id,
										table.tableName,
									])
								);
							}
							// we might want to prefetch here
							const binary_entry = table.primaryStore.getBinaryFast(record_id);
							if (binary_entry) {
								const entry = table.primaryStore.decoder.decode(binary_entry, { valueAsBuffer: true });
								response_data = encode([
									GET_RECORD_RESPONSE,
									request_id,
									{
										value: entry.value,
										expiresAt: entry.expiresAt,
										version: entry.version,
										residencyId: entry.residencyId,
										nodeId: entry.nodeId,
										user: entry.user,
									},
								]);
							} else {
								response_data = encode([GET_RECORD_RESPONSE, request_id]);
							}
						} catch (error) {
							response_data = encode([
								GET_RECORD_RESPONSE,
								request_id,
								{
									error: error.message,
								},
							]);
						}
						ws.send(response_data);
						break;
					}
					case GET_RECORD_RESPONSE: {
						// this is a response to a record request, we need to resolve the promise
						const { resolve, reject, tableId: table_id, key } = awaiting_response.get(message[1]);
						const entry = message[2];
						if (entry?.error) reject(new Error(entry.error));
						else if (entry) {
							const record = table_decoders[table_id].decoder.decode(entry.value);
							entry.value = record;
							entry.key = key;
							resolve(entry);
						} else resolve();
						awaiting_response.delete(message[1]);
						break;
					}
					case SUBSCRIPTION_REQUEST: {
						node_subscriptions = data;
						// permission check to make sure that this node is allowed to subscribe to this database, that is that
						// we have publish permission for this node/database
						let subscription_to_hdb_nodes, when_subscribed_to_hdb_nodes;
						let closed = false;
						if (table_subscription_to_replicator) {
							if (
								database_name !== table_subscription_to_replicator.databaseName &&
								!table_subscription_to_replicator.then
							) {
								logger.error?.(
									'Subscription request for wrong database',
									database_name,
									table_subscription_to_replicator.databaseName
								);
								return;
							}
						} else table_subscription_to_replicator = db_subscriptions.get(database_name);
						logger.debug?.(connection_id, 'received subscription request for', database_name, 'at', node_subscriptions);
						if (!table_subscription_to_replicator) {
							// Wait for it to be created
							let ready;
							table_subscription_to_replicator = new Promise((resolve) => {
								logger.debug?.('Waiting for subscription to database ' + database_name);
								ready = resolve;
							});
							table_subscription_to_replicator.ready = ready;
							database_subscriptions.set(database_name, table_subscription_to_replicator);
						}
						if (authorization.name) {
							when_subscribed_to_hdb_nodes = getHDBNodeTable().subscribe(authorization.name);
							when_subscribed_to_hdb_nodes.then(
								async (subscription) => {
									subscription_to_hdb_nodes = subscription;
									for await (const event of subscription_to_hdb_nodes) {
										const node = event.value;
										if (
											!(
												node?.replicates === true ||
												node?.replicates?.receives ||
												node?.subscriptions?.some(
													// TODO: Verify the table permissions for each table listed in the subscriptions
													(sub) => (sub.database || sub.schema) === database_name && sub.publish !== false
												)
											)
										) {
											closed = true;
											ws.send(encode([DISCONNECT]));
											close(1008, `Unauthorized database subscription to ${database_name}`);
											return;
										}
									}
								},
								(error) => {
									logger.error?.(connection_id, 'Error subscribing to HDB nodes', error);
								}
							);
						} else if (!(authorization?.permissions?.super_user || authorization.replicates)) {
							ws.send(encode([DISCONNECT]));
							close(1008, `Unauthorized database subscription to ${database_name}`);
							return;
						}

						if (audit_subscription) {
							// any subscription will supersede the previous subscription, so end that one
							logger.debug?.(connection_id, 'stopping previous subscription', database_name);
							audit_subscription.emit('close');
						}
						if (node_subscriptions.length === 0)
							// this means we are unsubscribing
							return;
						let first_table;
						const first_node = node_subscriptions[0];
						const tableToTableEntry = (table) => {
							if (
								table &&
								(first_node.replicateByDefault
									? !first_node.tables.includes(table.tableName)
									: first_node.tables.includes(table.tableName))
							) {
								first_table = table;
								return { table };
							}
						};
						const current_transaction = { txnTime: 0 };
						let subscribed_node_ids, table_by_id;
						let current_sequence_id = Infinity; // the last sequence number in the audit log that we have processed, set this with a finite number from the subscriptions
						let sent_sequence_id; // the last sequence number we have sent
						const sendAuditRecord = (audit_record, local_time) => {
							current_sequence_id = local_time;
							if (audit_record.type === 'end_txn') {
								if (current_transaction.txnTime) {
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error?.('Invalid encoding of message');
									}
									writeInt(9); // replication message of nine bytes long
									writeInt(REMOTE_SEQUENCE_UPDATE); // action id
									writeFloat64((sent_sequence_id = local_time)); // send the local time so we know what sequence number to start from next time.
									sendQueuedData();
								}
								encoding_start = position;
								current_transaction.txnTime = 0;
								return; // end of transaction, nothing more to do
							}
							const node_id = audit_record.nodeId;
							const table_id = audit_record.tableId;
							let table_entry = table_by_id[table_id];
							if (!table_entry) {
								table_entry = table_by_id[table_id] = tableToTableEntry(
									table_subscription_to_replicator.tableById[table_id]
								);
								if (!table_entry) {
									return logger.debug?.('Not subscribed to table', table_id);
								}
							}
							const table = table_entry.table;
							const primary_store = table.primaryStore;
							const encoder = primary_store.encoder;
							if (audit_record.extendedType & HAS_STRUCTURE_UPDATE || !encoder.typedStructs) {
								// there is a structure update, we need to reload the structure from storage.
								// this is copied from msgpackr's struct, may want to expose as public method
								encoder._mergeStructures(encoder.getStructures());
								if (encoder.typedStructs) encoder.lastTypedStructuresLength = encoder.typedStructs.length;
							}
							const time_range = subscribed_node_ids[node_id];
							const is_within_subscription_range =
								time_range &&
								time_range.startTime < local_time &&
								(!time_range.endTime || time_range.endTime > local_time);
							if (!is_within_subscription_range) {
								if (DEBUG_MODE)
									logger.trace?.(
										connection_id,
										'skipping replication update',
										audit_record.recordId,
										'to:',
										remote_node_name,
										'from:',
										node_id,
										'subscribed:',
										subscribed_node_ids
									);
								// we are skipping this message because it is being sent from another node, but we still want to
								// occasionally send a sequence update so that if we reconnect we don't have to go back to far in the
								// audit log
								return skipAuditRecord();
							}
							if (DEBUG_MODE)
								logger.trace?.(
									connection_id,
									'sending replication update',
									audit_record.recordId,
									'to:',
									remote_node_name,
									'from:',
									node_id,
									'subscribed:',
									subscribed_node_ids
								);
							const txn_time = audit_record.version;
							if (current_transaction.txnTime !== txn_time) {
								// send the queued transaction
								if (current_transaction.txnTime) {
									if (DEBUG_MODE)
										logger.trace?.(connection_id, 'new txn time, sending queued txn', current_transaction.txnTime);
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error?.('Invalid encoding of message');
									}
									sendQueuedData();
								}
								current_transaction.txnTime = txn_time;
								encoding_start = position;
								writeFloat64(txn_time);
							}

							const residency_id = audit_record.residencyId;
							const residency = getResidence(residency_id, table);
							let invalidation_entry;
							if (residency && !residency.includes(remote_node_name)) {
								// If this node won't have residency, we need to send out invalidation messages
								const previous_residency = getResidence(audit_record.previousResidencyId, table);
								if (
									(previous_residency &&
										!previous_residency.includes(remote_node_name) &&
										(audit_record.type === 'put' || audit_record.type === 'patch')) ||
									table.getResidencyById
								) {
									// if we were already omitted from the previous residency, we don't need to send out invalidation messages for record updates
									// or if we are using residency by id, this means we don't even need any data sent to other servers
									return skipAuditRecord();
								}
								const record_id = audit_record.recordId;
								// send out invalidation messages
								logger.trace?.(connection_id, 'sending invalidation', record_id, remote_node_name, 'from', node_id);
								let extended_type = 0;
								if (residency_id) extended_type |= HAS_CURRENT_RESIDENCY_ID;
								if (audit_record.previousResidencyId) extended_type |= HAS_PREVIOUS_RESIDENCY_ID;
								let full_record,
									partial_record = null;
								for (const name in table.indices) {
									if (!partial_record) {
										full_record = audit_record.getValue(primary_store, true);
										if (!full_record) break; // if there is no record, as is the case with a relocate, we can't send it
										partial_record = {};
									}
									// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
									partial_record[name] = full_record[name];
								}

								invalidation_entry = createAuditEntry(
									audit_record.version,
									table_id,
									record_id,
									null,
									node_id,
									audit_record.user,
									audit_record.type === 'put' || audit_record.type === 'patch' ? 'invalidate' : audit_record.type,
									encoder.encode(partial_record), // use the store's encoder; note that this may actually result in a new structure being created
									extended_type,
									residency_id,
									audit_record.previousResidencyId,
									audit_record.expiresAt
								);
								// entry is encoded, send it after checks for new structure and residency
							}

							// when we can skip an audit record, we still need to occasionally send a sequence update:
							function skipAuditRecord() {
								logger.trace?.(connection_id, 'skipping audit record', audit_record.recordId);
								if (!skipped_message_sequence_update_timer) {
									skipped_message_sequence_update_timer = setTimeout(() => {
										skipped_message_sequence_update_timer = null;
										// check to see if we are too far behind, but if so, send a sequence update
										if ((sent_sequence_id || 0) + SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY / 2 < current_sequence_id) {
											if (DEBUG_MODE)
												logger.trace?.(connection_id, 'sending skipped sequence update', current_sequence_id);
											ws.send(encode([SEQUENCE_ID_UPDATE, current_sequence_id]));
										}
									}, SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY).unref();
								}
							}

							const typed_structs = encoder.typedStructs;
							const structures = encoder.structures;
							if (
								typed_structs?.length != table_entry.typed_length ||
								structures?.length != table_entry.structure_length
							) {
								table_entry.typed_length = typed_structs?.length;
								table_entry.structure_length = structures.length;
								// the structure used for encoding records has changed, so we need to send the new structure
								logger.debug?.(
									connection_id,
									'send table struct',
									table_entry.typed_length,
									table_entry.structure_length
								);
								if (!table_entry.sentName) {
									table_entry.sentName = true;
								}
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs: typed_structs,
											structures: structures,
											attributes: table.attributes,
											schemaDefined: table.schemaDefined,
										},
										table_id,
										table_entry.table.tableName,
									])
								);
							}
							if (residency_id && !sent_residency_lists[residency_id]) {
								ws.send(encode([RESIDENCY_LIST, residency, residency_id]));
								sent_residency_lists[residency_id] = true;
							}
							/*
							TODO: At some point we may want some fancier logic to elide the version (which is the same as txn_time)
							and username from subsequent audit entries in multiple entry transactions*/
							if (invalidation_entry) {
								// if we have an invalidation entry to send, do that now
								writeInt(invalidation_entry.length);
								writeBytes(invalidation_entry);
							} else {
								// directly write the audit record. If it starts with the previous local time, we omit that
								const encoded = audit_record.encoded;
								const start = encoded[0] === 66 ? 8 : 0;
								writeInt(encoded.length - start);
								writeBytes(encoded, start);
							}
						};
						const sendQueuedData = () => {
							if (position - encoding_start > 8) {
								// if we have more than just a txn time, send it
								ws.send(encoding_buffer.subarray(encoding_start, position));
								logger.debug?.(connection_id, 'Sent message, size:', position - encoding_start);
							} else logger.debug?.(connection_id, 'skipping empty transaction');
						};

						audit_subscription = new EventEmitter();
						audit_subscription.once('close', () => {
							closed = true;
							subscription_to_hdb_nodes?.end();
						});
						// find the earliest start time of the subscriptions
						for (const { startTime } of node_subscriptions) {
							if (startTime < current_sequence_id) current_sequence_id = startTime;
						}
						// wait for internal subscription, might be waiting for a table to be registered
						(when_subscribed_to_hdb_nodes || Promise.resolve())
							.then(async () => {
								table_subscription_to_replicator = await table_subscription_to_replicator;
								audit_store = table_subscription_to_replicator.auditStore;
								table_by_id = table_subscription_to_replicator.tableById.map(tableToTableEntry);
								subscribed_node_ids = [];
								for (const { name, startTime, endTime } of node_subscriptions) {
									const local_id = getIdOfRemoteNode(name, audit_store);
									logger.debug?.('subscription to', name, 'using local id', local_id, 'starting', startTime);
									subscribed_node_ids[local_id] = { startTime, endTime };
								}

								sendDBSchema(database_name);
								if (!schema_update_listener) {
									schema_update_listener = onUpdatedTable((table) => {
										if (table.databaseName === database_name) {
											sendDBSchema(database_name);
										}
									});
									db_removal_listener = onRemovedDB((db) => {
										// I guess if a database is removed then we disconnect. This is kind of weird situation for replication,
										// as the replication system will try to preserve consistency between nodes and their databases, and
										// it is unclear what to do if a database is removed and what that means for consistency seekingd
										if (db === database_name) {
											ws.send(encode([DISCONNECT]));
											close();
										}
									});
									ws.on('close', () => {
										schema_update_listener?.remove();
										db_removal_listener?.remove();
									});
								}
								// Send a message to the remote node with the node id mapping, indicating how each node name is mapped to a short id
								// and a list of the node names that are subscribed to this node
								ws.send(
									encode([
										NODE_NAME_TO_ID_MAP,
										exportIdMapping(table_subscription_to_replicator.auditStore),
										node_subscriptions.map(({ name }) => name),
									])
								);

								let is_first = true;
								do {
									// We run subscriptions as a loop where retrieve entries from the audit log, since the last entry
									// and sending out the results while applying back-pressure from the socket. When we are out of entries
									// then we switch to waiting/listening for the next transaction notifications before resuming the iteration
									// through the audit log.
									if (!isFinite(current_sequence_id)) {
										logger.warn?.('Invalid sequence id ' + current_sequence_id);
										close(1008, 'Invalid sequence id' + current_sequence_id);
									}
									let queued_entries;
									if (is_first && !closed) {
										is_first = false;
										const last_removed = getLastRemoved(audit_store);
										if (!(last_removed <= current_sequence_id)) {
											// This means the audit log doesn't extend far enough back, so we need to replicate all the tables
											// This should only be done on a single node, we don't want full table replication from all the
											// nodes that are connected to this one:
											if (server.nodes[0]?.name === remote_node_name) {
												logger.info?.('Replicating all tables to', remote_node_name);
												let last_sequence_id = current_sequence_id;
												const node_id = getThisNodeId(audit_store);
												for (const table_name in tables) {
													const table = tables[table_name];
													for (const entry of table.primaryStore.getRange({
														snapshot: false,
														// values: false, // TODO: eventually, we don't want to decode, we want to use fast binary transfer
													})) {
														if (closed) return;
														if (entry.localTime >= current_sequence_id) {
															logger.trace?.(
																connection_id,
																'Copying record from',
																database_name,
																table_name,
																entry.key,
																entry.localTime
															);
															last_sequence_id = Math.max(entry.localTime, last_sequence_id);
															queued_entries = true;
															sendAuditRecord(
																{
																	// make it look like an audit record
																	recordId: entry.key,
																	tableId: table.tableId,
																	type: 'put',
																	getValue() {
																		return entry.value;
																	},
																	encoded: table.primaryStore.getBinary(entry.key), // directly transfer binary data
																	version: entry.version,
																	residencyId: entry.residencyId,
																	nodeId: node_id,
																},
																entry.localTime
															);
														}
													}
												}
												current_sequence_id = last_sequence_id;
											}
										}
									}
									for (const { key, value: audit_entry } of audit_store.getRange({
										start: current_sequence_id || 1,
										exclusiveStart: true,
										snapshot: false, // don't want to use a snapshot, and we want to see new entries
									})) {
										if (closed) return;
										last_audit_sent = key;
										const audit_record = readAuditEntry(audit_entry);
										sendAuditRecord(audit_record, key);
										// wait if there is back-pressure
										if (ws._socket.writableNeedDrain) {
											await new Promise((resolve) => ws._socket.once('drain', resolve));
										}
										//await rest(); // possibly yield occasionally for fairness
										audit_subscription.startTime = key; // update so don't double send
										queued_entries = true;
									}
									if (queued_entries)
										sendAuditRecord(
											{
												type: 'end_txn',
											},
											current_sequence_id
										);

									last_audit_sent = 0; // indicate that we have sent all the audit log entries, we are not catching up right now
									await whenNextTransaction(audit_store);
								} while (!closed);
							})
							.catch((error) => {
								logger.error?.(connection_id, 'Error handling subscription to node', error);
								close(1008, 'Error handling subscription to node');
							});
						break;
					}
				}
				return;
			}

			/* If we are past the commands, we are now handling an incoming replication message, the next block
			 * handles parsing and transacting these replication messages */
			decoder.position = 8;
			let begin_txn = true;
			let event; // could also get txn_time from decoder.getFloat64(0);
			let sequence_id_received;
			do {
				const event_length = decoder.readInt();
				if (event_length === 9 && decoder.getUint8(decoder.position) == REMOTE_SEQUENCE_UPDATE) {
					decoder.position++;
					last_sequence_id_received = sequence_id_received = decoder.readFloat64();
					logger.trace?.('received remote sequence update', last_sequence_id_received, database_name);
					break;
				}
				const start = decoder.position;
				const audit_record = readAuditEntry(body, start, start + event_length);
				const table_decoder = table_decoders[audit_record.tableId];
				if (!table_decoder) {
					logger.error?.(`No table found with an id of ${audit_record.tableId}`);
				}
				let residency_list;
				if (audit_record.residencyId) {
					residency_list = received_residency_lists[audit_record.residencyId];
					logger.trace?.(
						connection_id,
						'received residency list',
						residency_list,
						audit_record.type,
						audit_record.recordId
					);
				}
				try {
					event = {
						table: table_decoder.name,
						id: audit_record.recordId,
						type: audit_record.type,
						nodeId: remote_short_id_to_local_id.get(audit_record.nodeId),
						residencyList: residency_list,
						timestamp: audit_record.version,
						value: audit_record.getValue(table_decoder),
						user: audit_record.user,
						beginTxn: begin_txn,
						expiresAt: audit_record.expiresAt,
					};
				} catch (error) {
					error.message += 'typed structures for current decoder' + JSON.stringify(table_decoder.decoder.typedStructs);
					throw error;
				}
				begin_txn = false;
				// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
				if (DEBUG_MODE)
					logger.trace?.(
						connection_id,
						'received replication message',
						audit_record.type,
						'id',
						event.id,
						'version',
						audit_record.version,
						'nodeId',
						event.nodeId,
						'value',
						event.value
					);
				table_subscription_to_replicator.send(event);
				decoder.position = start + event_length;
			} while (decoder.position < body.byteLength);
			outstanding_commits++;
			recordAction(
				body.byteLength,
				'bytes-received',
				remote_node_name + '.' + database_name + '.' + event.table,
				'replication',
				'ingest'
			);
			if (outstanding_commits > MAX_OUTSTANDING_COMMITS && !replication_paused) {
				replication_paused = true;
				ws.pause();
			}
			table_subscription_to_replicator.send({
				type: 'end_txn',
				localTime: last_sequence_id_received,
				remoteNodeIds: receiving_data_from_node_ids,
				onCommit() {
					if (event) {
						const latency = Date.now() - event.timestamp;
						recordAction(
							latency,
							'replication-latency',
							remote_node_name + '.' + database_name + '.' + event.table,
							event.type,
							'ingest'
						);
					}
					outstanding_commits--;
					if (replication_paused) {
						replication_paused = false;
						ws.resume();
					}
					if (!last_sequence_id_committed && sequence_id_received) {
						logger.trace?.(connection_id, 'queuing confirmation of a commit at', sequence_id_received);
						setTimeout(() => {
							ws.send(encode([COMMITTED_UPDATE, last_sequence_id_committed]));
							logger.trace?.(connection_id, 'sent confirmation of a commit at', last_sequence_id_committed);
							last_sequence_id_committed = null;
						}, COMMITTED_UPDATE_DELAY);
					}
					last_sequence_id_committed = sequence_id_received;
				},
			});
		} catch (error) {
			logger.error?.(connection_id, 'Error handling incoming replication message', error);
		}
	});
	ws.on('ping', resetPingTimer);
	ws.on('pong', () => {
		if (options.connection) {
			// every pong we can use to update our connection information (and latency)
			options.connection.latency = performance.now() - last_ping_time;
			// update the manager with latest connection information
			connectedToNode({
				name: remote_node_name,
				database: database_name,
				url: options.url,
				lastSendTime: last_audit_sent,
				latency: options.connection.latency,
			});
		}
		last_ping_time = null;
	});
	ws.on('close', (code, reason_buffer) => {
		// cleanup
		clearInterval(send_ping_interval);
		clearTimeout(receive_ping_timer);
		if (audit_subscription) audit_subscription.emit('close');
		if (subscription_request) subscription_request.end();
		for (const [id, { reject }] of awaiting_response) {
			reject(new Error(`Connection closed ${reason_buffer?.toString()} ${code}`));
		}
		logger.debug?.(connection_id, 'closed', code, reason_buffer?.toString());
	});

	function recordRemoteNodeSequence() {}

	function close(code?, reason?) {
		ws.isFinished = true;
		ws.close(code, reason);
	}
	function sendSubscriptionRequestUpdate() {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		if (!subscribed) {
			subscribed = true;
			options.connection?.on('subscriptions-updated', sendSubscriptionRequestUpdate);
		}
		if (options.connection?.isFinished)
			throw new Error('Can not make a subscription request on a connection that is already closed');
		const last_txn_times = new Map();
		// iterate through all the sequence entries and find the newest txn time for each node
		try {
			for (const entry of table_subscription_to_replicator?.dbisDB?.getRange({
				start: Symbol.for('seq'),
				end: [Symbol.for('seq'), Buffer.from([0xff])],
			}) || []) {
				for (const node of entry.value.nodes || []) {
					if (node.lastTxnTime > (last_txn_times.get(node.id) ?? 0)) last_txn_times.set(node.id, node.lastTxnTime);
				}
			}
		} catch (error) {
			// if the database is closed, just proceed (matches multiple error messages)
			if (!error.message.includes('Can not re')) throw error;
		}
		const connected_node = options.connection?.nodeSubscriptions?.[0];
		receiving_data_from_node_ids = [];
		const node_subscriptions = options.connection?.nodeSubscriptions.map((node: any, index: number) => {
			const table_subs = [];
			let { replicateByDefault: replicate_by_default } = node;
			if (node.subscriptions) {
				// if the node has explicit subscriptions, we need to use that to determine subscriptions
				for (const subscription of node.subscriptions) {
					// if there is an explicit subscription listed
					if (subscription.subscribe && (subscription.schema || subscription.database) === database_name) {
						const table_name = subscription.table;
						if (tables?.[table_name]?.replicate !== false)
							// if replication is enabled for this table
							table_subs.push(table_name);
					}
				}
				replicate_by_default = false; // now turn off the default replication because it was an explicit list of subscriptions
			} else {
				// note that if replicateByDefault is enabled, we are listing the *excluded* tables
				for (const table_name in tables) {
					if (replicate_by_default ? tables[table_name].replicate === false : tables[table_name].replicate)
						table_subs.push(table_name);
				}
			}

			const node_id = audit_store && getIdOfRemoteNode(node.name, audit_store);
			const sequence_entry = table_subscription_to_replicator?.dbisDB?.get([Symbol.for('seq'), node_id]) ?? 1;
			// if we are connected directly to the node, we start from the last sequence number we received at the top level
			let start_time = Math.max(
				sequence_entry?.seqId ?? 1,
				(typeof node.start_time === 'string' ? new Date(node.start_time).getTime() : node.start_time) ?? 1
			);
			logger.debug?.(
				'Starting time recorded in db',
				node.name,
				node_id,
				database_name,
				sequence_entry?.seqId,
				'start time:',
				start_time
			);
			if (connected_node !== node) {
				// indirect connection through a proxying node
				if (start_time > 5000) start_time -= 5000; // first, decrement the start time to cover some clock drift between nodes (5 seconds)
				// if there is a last sequence id we received through the proxying node that is newer, we can start from there
				const connected_node_id = audit_store && getIdOfRemoteNode(connected_node.name, audit_store);
				const sequence_entry =
					table_subscription_to_replicator?.dbisDB?.get([Symbol.for('seq'), connected_node_id]) ?? 1;
				for (const seq_node of sequence_entry?.nodes || []) {
					if (seq_node.name === node.name) {
						start_time = seq_node.seqId;
						logger.debug?.('Using sequence id from proxy node', connected_node.name, start_time);
					}
				}
			}
			receiving_data_from_node_ids.push(node_id);
			// if another node had previously acted as a proxy, it may not have the same sequence ids, but we can use the last
			// originating txn time, and sequence ids should always be higher than their originating txn time, and starting from them should overlap
			if (last_txn_times.get(node_id) > start_time) {
				start_time = last_txn_times.get(node_id);
				logger.debug?.('Updating start time from more recent txn recorded', connected_node.name, start_time);
			}
			return {
				name: node.name,
				replicateByDefault: replicate_by_default,
				tables: table_subs, // omitted or included based on flag above
				startTime: start_time,
				endTime: node.end_time,
			};
		});

		if (node_subscriptions) {
			logger.debug?.(
				connection_id,
				'sending subscription request',
				node_subscriptions,
				table_subscription_to_replicator?.dbisDB?.path
			);
			clearTimeout(delayed_close);
			if (node_subscriptions.length > 0) ws.send(encode([SUBSCRIPTION_REQUEST, node_subscriptions]));
			else {
				// no nodes means we are unsubscribing/disconnecting
				// don't immediately close the connection, but wait a bit to see if we get any messages, since opening new connections is a bit expensive
				const schedule_close = () => {
					const scheduled = performance.now();
					delayed_close = setTimeout(() => {
						// if we have not received any messages in a while, we can close the connection
						if (last_message_time <= scheduled) close(1008, 'No nodes to subscribe to');
						else schedule_close();
					}, DELAY_CLOSE_TIME);
				};
				schedule_close();
			}
		}
	}

	function getResidence(residency_id, table) {
		if (!residency_id) return;
		let residency = residency_map[residency_id];
		if (!residency) {
			residency = table.getResidencyRecord(residency_id);
			residency_map[residency_id] = residency;
			// TODO: Send the residency record
		}
		return residency;
	}

	function checkDatabaseAccess(database_name: string) {
		if (
			enabled_databases &&
			enabled_databases != '*' &&
			!enabled_databases[database_name] &&
			!enabled_databases.includes?.(database_name) &&
			!enabled_databases.some?.((db_config) => db_config.name === database_name)
		) {
			// TODO: Check the authorization as well
			return false;
		}
		return true;
	}
	function setDatabase(database_name) {
		table_subscription_to_replicator = table_subscription_to_replicator || db_subscriptions.get(database_name);
		if (!checkDatabaseAccess(database_name)) {
			throw new Error(`Access to database "${database_name}" is not permitted`);
		}
		if (!table_subscription_to_replicator) {
			logger.warn?.(`No database named "${database_name}" was declared and registered`);
		}
		audit_store = table_subscription_to_replicator?.auditStore;
		if (!tables) tables = getDatabases()?.[database_name];

		const this_node_name = getThisNodeName();
		if (this_node_name === remote_node_name) {
			if (!this_node_name) throw new Error('Node name not defined');
			else throw new Error('Should not connect to self', this_node_name);
		}
		sendNodeDBName(this_node_name, database_name);
		return true;
	}
	function sendNodeDBName(this_node_name, database_name) {
		const database = getDatabases()?.[database_name];
		const tables = [];
		for (const table_name in database) {
			const table = database[table_name];
			tables.push({
				table: table_name,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}
		logger.trace?.('Sending database info for node', this_node_name, 'database name', database_name);
		ws.send(encode([NODE_NAME, this_node_name, database_name, tables]));
	}
	function sendDBSchema(database_name) {
		const database = getDatabases()?.[database_name];
		const tables = [];
		for (const table_name in database) {
			if (
				node_subscriptions &&
				!node_subscriptions.some((node) => {
					return node.replicateByDefault ? !node.tables.includes(table_name) : node.tables.includes(table_name);
				})
			)
				continue;
			const table = database[table_name];
			tables.push({
				table: table_name,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}

		ws.send(encode([DB_SCHEMA, tables, database_name]));
	}
	let next_id = 1;
	const sent_table_names = [];
	return {
		end() {
			// cleanup
			if (subscription_request) subscription_request.end();
			if (audit_subscription) audit_subscription.emit('close');
		},
		getRecord(request) {
			// send a request for a specific record
			const request_id = next_id++;
			return new Promise((resolve, reject) => {
				const message = [GET_RECORD, request_id, request.table.tableId, request.id];
				if (!sent_table_names[request.table.tableId]) {
					message.push(request.table.tableName);
					sent_table_names[request.table.tableId] = true;
				}
				ws.send(encode(message));
				awaiting_response.set(request_id, {
					tableId: request.table.tableId,
					key: request.id,
					resolve(entry) {
						const { table, entry: existing_entry } = request;
						// we can immediately resolve this because the data is available.
						resolve(entry);
						// However, if we are going to record this locally, we need to record it as a relocation event
						// and determine new residency information
						if (entry) table._recordRelocate(existing_entry, entry);
					},
					reject,
				});
			});
		},
		/**
		 * Send an operation request to the remote node, returning a promise for the result
		 * @param operation
		 */
		sendOperation(operation) {
			const request_id = next_id++;
			operation.requestId = request_id;
			ws.send(encode([OPERATION_REQUEST, operation]));
			return new Promise((resolve, reject) => {
				awaiting_response.set(request_id, { resolve, reject });
			});
		},
	};

	// write an integer to the current buffer
	function writeInt(number) {
		checkRoom(5);
		if (number < 128) {
			encoding_buffer[position++] = number;
		} else if (number < 0x4000) {
			data_view.setUint16(position, number | 0x8000);
			position += 2;
		} else if (number < 0x3f000000) {
			data_view.setUint32(position, number | 0xc0000000);
			position += 4;
		} else {
			encoding_buffer[position] = 0xff;
			data_view.setUint32(position + 1, number);
			position += 5;
		}
	}

	// write raw binary/bytes to the current buffer
	function writeBytes(src, start = 0, end = src.length) {
		const length = end - start;
		checkRoom(length);
		src.copy(encoding_buffer, position, start, end);
		position += length;
	}

	function writeFloat64(number) {
		checkRoom(8);
		data_view.setFloat64(position, number);
		position += 8;
	}
	function checkRoom(length) {
		if (length + 16 > encoding_buffer.length - position) {
			const new_buffer = Buffer.allocUnsafeSlow(((position + length - encoding_start + 0x10000) >> 10) << 11);
			encoding_buffer.copy(new_buffer, 0, encoding_start, position);
			position = position - encoding_start;
			encoding_start = 0;
			encoding_buffer = new_buffer;
			data_view = new DataView(encoding_buffer.buffer, 0, encoding_buffer.length);
		}
	}
}

class Encoder {
	constructor() {}
}
// Check the attributes in the msg vs the table and if they dont match call ensureTable to create them
function ensureTableIfChanged(table_definition, existing_table) {
	const db_name = table_definition.database ?? 'data';
	if (db_name !== 'data' && !databases[db_name]) {
		logger.warn?.('Database not found', table_definition.database);
		return;
	}
	if (!existing_table) existing_table = {};
	let has_changes = false;
	const schema_defined = table_definition.schemaDefined;
	const attributes = existing_table.attributes || [];
	for (let i = 0; i < table_definition.attributes?.length; i++) {
		const ensure_attribute = table_definition.attributes[i];
		const existing_attribute = attributes[i];
		if (
			!existing_attribute ||
			existing_attribute.name !== ensure_attribute.name ||
			existing_attribute.type !== ensure_attribute.type
		) {
			has_changes = true;
			if (!schema_defined) ensure_attribute.indexed = true; // if it is a dynamic schema, we need to index (all) the attributes
			attributes[i] = ensure_attribute;
		}
	}
	if (has_changes) {
		logger.debug?.('(Re)creating', table_definition);
		return ensureTable({
			table: table_definition.table,
			database: table_definition.database,
			schemaDefined: table_definition.schemaDefined,
			attributes,
			...existing_table,
		});
	}
	return existing_table;
}
