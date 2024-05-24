import { getDatabases, databases, table as ensureTable } from '../../resources/databases';
import {
	createAuditEntry,
	Decoder,
	getLastRemoved,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	readAuditEntry,
} from '../../resources/auditStore';
import { exportIdMapping, getIdOfRemoteNode, remoteToLocalNodeId } from './nodeIdMapping';
import { whenNextTransaction } from '../../resources/transactionBroadcast';
import { forEachReplicatedDatabase, getThisNodeName, urlToNodeName } from './replicator';
import env from '../../utility/environment/environmentManager';
import { readAuditEntry, Decoder, REMOTE_SEQUENCE_UPDATE } from '../../resources/auditStore';
import { HAS_STRUCTURE_UPDATE } from '../../resources/RecordEncoder';
import { CERT_PREFERENCE_REP } from '../../utility/terms/certificates';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { threadId } from 'worker_threads';
import * as logger from '../../utility/logging/harper_logger';
import { disconnectedFromNode, connectedToNode, getHDBNodeTable } from './subscriptionManager';
import { EventEmitter } from 'events';
import { rootCertificates } from 'node:tls';
import { broadcast } from '../../server/threads/manageThreads';
import { applyTLS } from '../../security/keys';
import * as https from 'node:https';
import * as tls from 'node:tls';
//import { operation } from '../../server/serverHelpers/serverUtilities';

const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const DISCONNECT = 142;
const RESIDENCY_LIST = 130;
const TABLE_STRUCTURE = 131;
const TABLE_FIXED_STRUCTURE = 132;
export const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const SEQUENCE_ID_UPDATE = 143;
const COMMITTED_UPDATE = 144;
export const table_update_listeners = new Map();
export const database_subscriptions = new Map();
const DEBUG_MODE = true;
const SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY = 300;
// The amount time to await after a commit before sending out a committed update (and aggregating all updates).
// We want it be fairly quick so we can let the sending node know that we have received and committed the update.
const COMMITTED_UPDATE_DELAY = 2;
const PING_INTERVAL = 300000;
export let awaiting_response = new Map();
let secure_contexts;
/**
 * Handles reconnection, and requesting catch-up
 */

export async function createWebSocket(url, options?) {
	const { authorization, rejectUnauthorized } = options || {};
	if (!secure_contexts) secure_contexts = await applyTLS('operations-api');
	let node_name = getThisNodeName();
	let secure_context;
	if (url.includes('wss://')) {
		secure_context = secure_contexts.get(node_name)?.context ?? secure_contexts.default;
		if (secure_context) logger.info('Creating web socket for URL', url, 'with certificate named:', secure_context.name);
		if (!secure_context && rejectUnauthorized !== false) {
			throw new Error('Unable to find a valid certificate to use for replication to connect to ' + url);
		}
	}
	const headers = {};
	if (authorization) {
		headers.Authorization = authorization;
	}
	if (rejectUnauthorized === false) {
		return new WebSocket(url, 'harperdb-replication-v1', {
			headers,
			rejectUnauthorized: false,
		});
	}
	return new WebSocket(url, 'harperdb-replication-v1', {
		headers,
		rejectUnauthorized: true,
		localAddress: node_name?.startsWith('127.0') ? node_name : undefined,
		noDelay: true,
		secureContext: secure_context,
		// we set this very high (2x times the v22 default) because it performs better
		highWaterMark: 128 * 1024,
	});
}
export class NodeReplicationConnection extends EventEmitter {
	socket: WebSocket;
	startTime: number;
	retryTime = 2000;
	retries = 0;
	hasConnected: boolean;
	nodeSubscriptions = [];
	replicateTablesByDefault: boolean;
	nodeName: string;
	constructor(public url, public subscription, public databaseName) {
		super();
		this.nodeName = urlToNodeName(url);
	}

	async connect() {
		const tables = [];
		// TODO: Need to do this specifically for each node
		this.socket = await createWebSocket(this.url);

		let session;
		this.socket.on('open', () => {
			logger.info('Connected to ' + this.url, this.socket._socket.writableHighWaterMark);
			this.retries = 0;
			this.retryTime = 2000;
			// if we have already connected, we need to send a reconnected event
			connectedToNode({
				name: this.nodeName,
				database: this.databaseName,
				url: this.url,
			});
			this.hasConnected = true;
			session = replicateOverWS(
				this.socket,
				{
					database: this.databaseName,
					subscription: this.subscription,
					url: this.url,
					connection: this,
				},
				{ publish: true } // pre-authorized, but should only make publish: true if we are allowing reverse subscriptions
			);
		});
		this.socket.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED') {
				logger.error('Error in connection to ' + this.url, error.message);
			}
		});
		this.socket.on('close', (code, reason_buffer) => {
			if (this.socket.isFinished) {
				session?.end();
				return;
			}
			session?.disconnected();
			if (++this.retries % 20 === 1) {
				const reason = reason_buffer?.toString();
				logger.warn(
					`${session ? 'Disconnected from' : 'Failed to connect to'} ${this.url} (db: "${this.databaseName}"), due to ${
						reason ? '"' + reason + '" ' : ''
					}(code: ${code})`
				);
			}
			session = null;
			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, this.retryTime).unref();
			this.retryTime += this.retryTime >> 3; // increase by 12% each time
		});
	}
	subscribe(node_subscriptions, replicate_tables_by_default) {
		this.nodeSubscriptions = node_subscriptions;
		this.replicateTablesByDefault = replicate_tables_by_default;
		this.emit('subscriptions-updated', node_subscriptions);
	}

	send(message) {}
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
	logger.info(connection_id, 'registering');

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
	let tables = options.tables || (database_name && getDatabases()[database_name]);
	if (!authorization) {
		logger.error('No authorization provided');
		// don't send disconnect because we want the client to potentially retry
		close(1008, 'Unauthorized');
		return;
	}
	let remote_node_name = authorization.name;
	if (remote_node_name && options.connection) options.connection.nodeName = remote_node_name;
	let last_sequence_id_received, last_sequence_id_committed;
	const this_node_url = env.get('replication_url');
	let send_ping_interval, receive_ping_timer, last_ping_time, skipped_message_sequence_update_timer;
	if (options.url) {
		const send_ping = () => {
			if (last_ping_time) ws.terminate(); // timeout
			else {
				last_ping_time = performance.now();
				ws.ping();
			}
		};
		send_ping_interval = setInterval(send_ping, PING_INTERVAL);
		send_ping(); // send the first ping immediately so we can measure latency
	} else {
		resetPingTimer();
	}
	function resetPingTimer() {
		clearTimeout(receive_ping_timer);
		receive_ping_timer = setTimeout(() => {
			logger.warn(`Timeout waiting for ping from ${remote_node_name}, terminating connection and reconnecting`);
			ws.terminate();
		}, PING_INTERVAL * 2);
	}
	if (database_name) {
		setDatabase(database_name);
	}
	const table_decoders = [];
	let incoming_subscription_nodes;
	const residency_map = [];
	const sent_residency_lists = [];
	const received_residency_lists = [];
	const MAX_OUTSTANDING_COMMITS = 150;
	let outstanding_commits = 0;
	let replication_paused;
	let subscription_request, audit_subscription;
	let remote_sequence_number;
	let remote_short_id_to_local_id: Map<number, number>;
	ws.on('message', (body) => {
		// A replication header should consist of:
		// transaction timestamp
		// the record-transaction key (encoded using ordered-binary):
		//   table id
		//   record id
		// predicate information? (alternately we may send stream synchronization messages)
		// routing plan id (id for the route from source node to all receiving nodes)
		//
		// otherwise it a MessagePack encoded message
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
									logger.error(
										connection_id,
										`Node name mismatch, expecting to connect to ${remote_node_name}, but peer reported name as ${data}, disconnecting`
									);
									ws.send(encode([DISCONNECT]));
									close(1008, 'Node name mismatch');
									return;
								}
							} else remote_node_name = data;
							if (options.connection) options.connection.nodeName = remote_node_name;
							//const url = message[3] ?? this_node_url;
							logger.info(connection_id, 'received node id', remote_node_name, database_name);
							if (!database_name) {
								try {
									setDatabase((database_name = message[2]));
									if (database_name === 'system') {
										forEachReplicatedDatabase(options, (database, database_name) => {
											sendDatabaseInfo(null, database_name);
										});
									}
								} catch (error) {
									// if this fails, we should close the connection and indicate that we should not reconnect
									ws.send(encode([DISCONNECT]));
									close(1008, error.message);
									return;
								}
							}
							logger.info(connection_id, 'setDatabase', database_name, tables && Object.keys(tables));
							sendSubscriptionRequestUpdate();
						}
						for (let table_definition of message[3]) {
							const database_name = message[2];
							table_definition.database = database_name;
							logger.info(connection_id, 'Received table definition', table_definition);
							ensureTableIfChanged(table_definition, databases[database_name]?.[table_definition.table]);
						}

						break;
					}
					case DISCONNECT:
						close();
						break;
					case OPERATION_REQUEST:
						try {
							let is_authorized_node = authorization?.publish || authorization?.subscribers;
							server.operation(data, { user: authorization }, !is_authorized_node).then(
								(response) => {
									response.requestId = data.requestId;
									ws.send(encode([OPERATION_RESPONSE, response]));
								},
								(error) => {
									ws.send(encode([OPERATION_RESPONSE, { requestId: data.requestId, error: error.toString() }]));
								}
							);
						} catch (error) {
							ws.send(encode([OPERATION_RESPONSE, { requestId: data.requestId, error: error.toString() }]));
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
							if (database_name) logger.error(connection_id, 'No tables found for', database_name);
							else logger.error(connection_id, 'Database name never received');
						}
						let table = tables[table_name];
						table = ensureTableIfChanged(
							{ table: table_name, database: database_name, attributes: data.attributes },
							table
						);
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
						remote_short_id_to_local_id = remoteToLocalNodeId(remote_node_name, data, audit_store);
						incoming_subscription_nodes = message[2];
						logger.info(
							connection_id,
							`Acknowledged subscription request, receiving messages for nodes: ${incoming_subscription_nodes}`
						);
						break;
					case RESIDENCY_LIST:
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
						logger.info(connection_id, 'received and broadcasting committed update', data);
						replication_confirmation_float64.buffer.notify();
						break;
					case SEQUENCE_ID_UPDATE:
						// we need to record the sequence number that the remote node has received
						last_sequence_id_received = data;
						table_subscription_to_replicator.send({
							type: 'end_txn',
							localTime: last_sequence_id_received,
							remoteNodes: incoming_subscription_nodes,
						});
						break;
					case SUBSCRIPTION_REQUEST:
						const [action, db, , , node_subscriptions] = message;
						// permission check to make sure that this node is allowed to subscribe to this database, that is that
						// we have publish permission for this node/database
						if (
							!(
								authorization.publish !== false ||
								authorization.subscriptions?.some(
									// TODO: Verify the table permissions for each table listed in the subscriptions
									(sub) => (sub.database || sub.schema) === database_name && sub.publish !== false
								)
							)
						) {
							ws.send(encode([DISCONNECT]));
							close(1008, 'Unauthorized database subscription');
							return;
						}
						if (table_subscription_to_replicator) {
							if (database_name !== table_subscription_to_replicator.databaseName) {
								logger.error(
									'Subscription request for wrong database',
									database_name,
									table_subscription_to_replicator.databaseName
								);
								return;
							}
						} else table_subscription_to_replicator = db_subscriptions.get(database_name);
						logger.info(connection_id, 'received subscription request for', database_name, 'at', node_subscriptions);
						if (!table_subscription_to_replicator) {
							logger.error('No database is registered to receive updates for', database_name);
							return;
						}
						if (audit_subscription) {
							logger.info(connection_id, 'stopping previous subscription', database_name);
							audit_subscription.emit('close');
						}
						if (node_subscriptions.length === 0)
							// use to unsubscribe
							return;
						let first_table;
						let first_node = node_subscriptions[0];
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
						const table_by_id = table_subscription_to_replicator.tableById.map(tableToTableEntry);
						const subscribed_node_ids = [];
						for (let { name, startTime } of node_subscriptions) {
							const local_id = getIdOfRemoteNode(name, audit_store);
							subscribed_node_ids[local_id] = startTime;
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
						const encoder = new Encoder();
						const current_transaction = { txnTime: 0 };
						let listening_for_overload = false;
						let current_sequence_id = Infinity; // the last sequence number in the audit log that we have processed, set this with a finite number from the subscriptions
						let sent_sequence_id; // the last sequence number we have sent
						const sendAuditRecord = (record_id, audit_record, local_time, begin_txn) => {
							current_sequence_id = local_time;
							// TOOD: Use begin_txn instead to find transaction delimiting
							if (audit_record.type === 'end_txn') {
								if (current_transaction.txnTime) {
									//if (DEBUG_MODE) logger.info(connection_id, 'sending replication message', encoding_start, position);
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error('Invalid encoding of message');
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
									return logger.trace('Not subscribed to table', table_id);
								}
							}
							const table = table_entry.table;
							let primary_store = table.primaryStore;
							let encoder = primary_store.encoder;
							if (audit_record.extendedType & HAS_STRUCTURE_UPDATE || !encoder.typedStructs) {
								// there is a structure update, fully load the entire record so it is all loaded into memory
								const value = audit_record.getValue(primary_store, true);
								JSON.stringify(value);
							}
							if (!(subscribed_node_ids[node_id] < local_time)) {
								if (DEBUG_MODE)
									logger.info(
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
								if (!skipped_message_sequence_update_timer) {
									skipped_message_sequence_update_timer = setTimeout(() => {
										skipped_message_sequence_update_timer = null;
										// check to see if we are too far behind, but if so, send a sequence update
										if (sent_sequence_id + SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY / 2 < current_sequence_id) {
											if (DEBUG_MODE)
												logger.info(connection_id, 'sending skipped sequence update', current_sequence_id);
											ws.send(encode([SEQUENCE_ID_UPDATE, current_sequence_id]));
										}
									}, SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY).unref();
								}
								return;
							}
							if (DEBUG_MODE)
								logger.info(
									connection_id,
									'preparing replication update',
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
										logger.info(connection_id, 'new txn time, sending queued txn', current_transaction.txnTime);
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error('Invalid encoding of message');
									}
									sendQueuedData();
								}
								current_transaction.txnTime = txn_time;
								encoding_start = position;
								writeFloat64(txn_time);
							}

							const residency_id = audit_record.residencyId;
							const residency = getResidence(residency_id, table);
							if (audit_record.previousResidencyId != undefined) {
								// or does it have a special type? auditRecord.type === 'residency-change') {
								// TODO: handle residency change, based on previous residency, we may need to send out full records
								// to the new owners of the record.
								// For previous owners, that are no longer owners, we need to send out invalidation messages
								const previous_residency = getResidence(audit_record.previousResidencyId, table);
								if (
									(!previous_residency || previous_residency.includes(remote_node_name)) &&
									residency &&
									!residency.includes(remote_node_name)
								) {
									const record_id = audit_record.recordId;
									// send out invalidation messages
									logger.info(connection_id, 'sending invalidation', record_id, remote_node_name, 'from', node_id);
									let extended_type = 0;
									if (residency_id) extended_type |= HAS_CURRENT_RESIDENCY_ID;
									if (audit_record.previousResidencyId) extended_type |= HAS_PREVIOUS_RESIDENCY_ID;
									const encoded_invalidation_entry = createAuditEntry(
										audit_record.version,
										table_id,
										record_id,
										null,
										node_id,
										audit_record.user,
										'invalidate',
										encoder.encode({ [table.primaryKey]: record_id }),
										extended_type,
										residency_id,
										audit_record.previousResidencyId
									);
									writeInt(encoded_invalidation_entry.length);
									writeBytes(encoded_invalidation_entry);
								}
								if (previous_residency && !previous_residency[remote_node_name] && audit_record.type !== 'put') {
									// send out full record if it is not a put
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
								logger.info(connection_id, 'send table struct', table_entry.typed_length, table_entry.structure_length);
								if (!table_entry.sentName) {
									// TODO: only send the table name once
									table_entry.sentName = true;
								}
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{ typedStructs: typed_structs, structures: structures, attributes: table.attributes },
										table_id,
										table_entry.table.tableName,
									])
								);
							}
							if (residency_id && !sent_residency_lists[residency_id]) {
								ws.send(encode([RESIDENCY_LIST, residency, residency_id]));
								sent_residency_lists[residency_id] = true;
							}
							if (residency && !residency.includes(remote_node_name)) return; // we don't need to send this record to this node, is it doesn't have a copy of it and doesn't own it
							/*
							TODO: At some point we may want some fancier logic to elide the version (which is the same as txn_time)
							and username from subsequent audit entries in multiple entry transactions*/
							/*
							writeInt(table_id);
							const key_length = record_id_binary.length;
							writeInt(key_length);
							writeBytes(record_id_binary);
							const encoded_record = audit_record.getBinaryValue();
							writeInt(encoded_record.length);
							writeBytes(encoded_record);
							*/
							// directly write the audit record. If it starts with the previous local time, we omit that
							const encoded = audit_record.encoded;
							const start = encoded[0] === 66 ? 8 : 0;
							writeInt(encoded.length - start);
							writeBytes(encoded, start);
						};
						const sendQueuedData = () => {
							ws.send(encoding_buffer.subarray(encoding_start, position));
						};

						let closed = false;
						audit_subscription = new EventEmitter();
						audit_subscription.on('close', () => {
							closed = true;
						});
						for (let { startTime } of node_subscriptions) {
							if (startTime < current_sequence_id) current_sequence_id = startTime;
						}
						(async () => {
							let is_first = true;
							do {
								// We run subscriptions as a loop where we can alternate between our two message delivery modes:
								// The catch-up pull mode where we are iterating a query since the last start time
								// and sending out the results while applying back-pressure from the socket.
								// Then we switch to the real-time push subscription mode where we are listening for updates
								// and sending them out immediately as we get them. If/when this mode gets overloaded, we switch back to
								// the catch-up mode.
								if (isFinite(current_sequence_id)) {
									let queued_entries;
									if (is_first) {
										is_first = false;
										let last_removed = getLastRemoved(audit_store);
										if (!(last_removed <= current_sequence_id)) {
											// this means the audit log doesn't extend far enough back, so we need to replicate all the tables
											// TODO: This should only be done on a single node, we don't want full table replication from all the
											// nodes that are connected to this one.
											let last_sequence_id = current_sequence_id;
											for (let table_name in tables) {
												const table = tables[table_name];
												for (const entry of table.primaryStore({
													snapshot: false,
												})) {
													if (entry.localTime >= current_sequence_id) {
														last_sequence_id = Math.max(entry.localTime, last_sequence_id);
														sendAuditRecord(null, entry, entry.localTime);
													}
												}
											}
											current_sequence_id = last_sequence_id;
										}
									}
									for (const { key, value: audit_entry } of audit_store.getRange({
										start: current_sequence_id || 1,
										exclusiveStart: true,
										snapshot: false, // don't want to use a snapshot, and we want to see new entries
									})) {
										if (closed) return;
										const audit_record = readAuditEntry(audit_entry);
										sendAuditRecord(null, audit_record, key);
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
											null,
											{
												type: 'end_txn',
											},
											current_sequence_id
										);
								}
								audit_subscription.on('close', () => {
									closed = true;
								});
								let listeners = table_update_listeners.get(first_table);
								if (!listeners) table_update_listeners.set(first_table, (listeners = []));
								listeners.push((table) => {
									// TODO: send table update
								});
								//logger.info(connection_id, 'Waiting for next transaction');
								await whenNextTransaction(audit_store);
								//logger.info(connection_id, 'Next transaction is ready');
							} while (!closed);
						})();
						break;
				}
				return;
			}
			// else we are handling a replication message
			decoder.position = 8;
			let begin_txn = true;
			//const txn_time = decoder.getFloat64(0);
			let sequence_id_received;
			do {
				/*const table_id = decoder.readInt();
				const key_length = decoder.readInt();
				const record_key = readKey(body, decoder.position, (decoder.position += key_length));*/
				const event_length = decoder.readInt();
				if (event_length === 9 && decoder.getUint8(decoder.position) == REMOTE_SEQUENCE_UPDATE) {
					decoder.position++;
					last_sequence_id_received = sequence_id_received = decoder.readFloat64();
					logger.info('received remote sequence update', last_sequence_id_received);
					break;
				}
				const start = decoder.position;
				const audit_record = readAuditEntry(body.subarray(start, start + event_length));
				const table_decoder = table_decoders[audit_record.tableId];
				if (!table_decoder) {
					logger.error(`No table found with an id of ${audit_record.tableId}`);
				}
				let residency_list;
				if (audit_record.residencyId) {
					residency_list = received_residency_lists[audit_record.residencyId];
					logger.info(
						connection_id,
						'received residency list',
						residency_list,
						audit_record.type,
						audit_record.recordId
					);
				}
				const event = {
					table: table_decoder.name,
					id: audit_record.recordId,
					type: audit_record.type,
					nodeId: remote_short_id_to_local_id.get(audit_record.nodeId),
					residencyList: residency_list,
					timestamp: audit_record.version,
					value: audit_record.getValue(table_decoders[audit_record.tableId]),
					user: audit_record.user,
					beginTxn: begin_txn,
				};
				begin_txn = false;
				// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
				if (DEBUG_MODE)
					logger.info(
						connection_id,
						'received replication message, id:',
						event.id,
						'version:',
						audit_record.version,
						'nodeId',
						event.nodeId,
						'name',
						event.value?.name
					);
				table_subscription_to_replicator.send(event);
				decoder.position = start + event_length;
			} while (decoder.position < body.byteLength);
			outstanding_commits++;
			if (outstanding_commits > MAX_OUTSTANDING_COMMITS && !replication_paused) {
				replication_paused = true;
				ws.pause();
			}
			table_subscription_to_replicator.send({
				type: 'end_txn',
				localTime: last_sequence_id_received,
				remoteNodes: incoming_subscription_nodes,
				onCommit() {
					outstanding_commits--;
					if (replication_paused) {
						replication_paused = false;
						ws.resume();
					}
					if (!last_sequence_id_committed && sequence_id_received) {
						logger.info(connection_id, 'queuing confirmation of a commit at', sequence_id_received);
						setTimeout(() => {
							ws.send(encode([COMMITTED_UPDATE, last_sequence_id_committed]));
							logger.info(connection_id, 'sent confirmation of a commit at', last_sequence_id_committed);
							last_sequence_id_committed = null;
						}, COMMITTED_UPDATE_DELAY);
					}
					last_sequence_id_committed = sequence_id_received;
				},
			});
		} catch (error) {
			logger.error(connection_id, 'Error handling incoming replication message', error);
		}
	});
	ws.on('ping', resetPingTimer);
	ws.on('pong', () => {
		if (options.connection)
			connectedToNode({
				name: remote_node_name,
				database: database_name,
				url: options.url,
				latency: performance.now() - last_ping_time,
			});
		last_ping_time = null;
	});
	ws.on('close', (code, reason_buffer) => {
		clearInterval(send_ping_interval);
		if (audit_subscription) audit_subscription.emit('close');
		if (subscription_request) subscription_request.end();
		logger.info(connection_id, 'closed', code, reason_buffer?.toString());
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
		/*		if (!last_sequence_id_received) {
			last_sequence_id_received =
				table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), remote_node_name]) ?? 1;
		}*/
		const node_subscriptions = options.connection?.nodeSubscriptions.map((node, index) => {
			let table_subs = [];
			let { replicateByDefault: replicate_by_default } = node;
			if (node.subscriptions) {
				// if the node has explicit subscriptions, we need to use that to determine subscriptions
				for (let subscription in node.subscriptions) {
					// if there is an explicit subscription listed
					if (subscription.subscribe && (subscription.schema || subscription.database) === database_name) {
						const table_name = subscription.table;
						if (replicate_by_default ? tables[table_name].replicate !== false : tables[table_name].replicate)
							// if replication is enabled for this table
							table_subs.push(subscription.table);
					}
				}
				replicate_by_default = false; // now turn off the default replication because it was an explicit list of subscriptions
			} else {
				// note that if replicateByDefault is enabled, we are listing the *excluded* tables
				for (let table_name in tables) {
					if (replicate_by_default ? tables[table_name].replicate === false : tables[table_name].replicate)
						table_subs.push(table_name);
				}
			}

			return {
				name: node.name,
				replicateByDefault: replicate_by_default,
				tables: table_subs, // omitted or included based on flag above
				startTime: (table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), node.name]) ?? 10001) - 10000,
			};
		});
		logger.info(
			connection_id,
			'sending subscription request',
			node_subscriptions,
			table_subscription_to_replicator?.dbisDB.path
		);

		if (node_subscriptions) {
			// no nodes means we are unsubscribing
			ws.send(encode([SUBSCRIPTION_REQUEST, database_name, last_sequence_id_received, null, node_subscriptions]));
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

	function setDatabase(database_name) {
		table_subscription_to_replicator = table_subscription_to_replicator || db_subscriptions.get(database_name);
		if (!table_subscription_to_replicator) {
			return logger.warn(`No database named "${database_name}" was declared and registered`);
		}
		audit_store = table_subscription_to_replicator.auditStore;
		if (!audit_store) {
			throw new Error('No audit store found in ' + database_name);
		}
		if (!tables) tables = getDatabases()?.[database_name];

		const this_node_name = getThisNodeName();
		if (this_node_name === remote_node_name) {
			if (!this_node_name) throw new Error('Node name not defined');
			else throw new Error('Should not connect to self', this_node_name);
		}
		sendDatabaseInfo(this_node_name, database_name);
		return true;
	}
	function sendDatabaseInfo(this_node_name, database_name) {
		let database = getDatabases()?.[database_name];
		let tables = [];
		for (let table_name in database) {
			let table = database[table_name];
			tables.push({
				table: table_name,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}
		logger.info('Sending database info for node', this_node_name, 'database name', database_name, tables);
		ws.send(encode([NODE_NAME, this_node_name, database_name, tables]));
	}

	return {
		end() {
			// cleanup
			if (subscription_request) subscription_request.end();
			if (audit_subscription) audit_subscription.emit('close');
		},
		disconnected() {
			// if we get disconnected, notify subscriptions manager so we can reroute through another node
			disconnectedFromNode({
				name: remote_node_name,
				database: database_name,
				url: options.url,
			});
			// TODO: When we get reconnected, we need to undo this
		},
	};

	function writeInt(number) {
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

	function writeBytes(src, start = 0, end = src.length) {
		const length = end - start;
		if (length + 16 > encoding_buffer.length - position) {
			const new_buffer = Buffer.allocUnsafeSlow(((length + 0x10000) >> 10) << 11);
			encoding_buffer.copy(new_buffer, 0, encoding_start, position);
			position = position - encoding_start;
			encoding_start = 0;
			encoding_buffer = new_buffer;
			data_view = new DataView(encoding_buffer.buffer, 0, encoding_buffer.length);
		}
		src.copy(encoding_buffer, position, start, end);
		position += length;
	}

	function writeFloat64(number) {
		if (16 > encoding_buffer.length - position) {
			const new_buffer = Buffer.allocUnsafeSlow(0x10000);
			encoding_buffer.copy(new_buffer, 0, encoding_start, position);
			position = position - encoding_start;
			encoding_start = 0;
			encoding_buffer = new_buffer;
			data_view = new DataView(encoding_buffer.buffer, 0, encoding_buffer.length);
		}
		data_view.setFloat64(position, number);
		position += 8;
	}
}

class Encoder {
	constructor() {}
}
// Check the attributes in the msg vs the table and if they dont match call ensureTable to create them
function ensureTableIfChanged(table_definition, existing_table) {
	if (!existing_table) existing_table = {};
	let has_changes = false;
	let attributes = existing_table.attributes || [];
	for (let i = 0; i < table_definition.attributes.length; i++) {
		let ensure_attribute = table_definition.attributes[i];
		let existing_attribute = attributes[i];
		if (
			!existing_attribute ||
			existing_attribute.name !== ensure_attribute.name ||
			existing_attribute.type !== ensure_attribute.type
		) {
			has_changes = true;
			attributes[i] = ensure_attribute;
		}
	}
	if (has_changes) {
		logger.error('(Re)creating', table_definition);
		return ensureTable({
			table: table_definition.table,
			database: table_definition.database,
			attributes,
			...existing_table,
		});
	}
	return existing_table;
}
