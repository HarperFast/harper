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
import { addSubscription } from '../../resources/transactionBroadcast';
import { getThisNodeName, urlToNodeName } from './replicator';
import env from '../../utility/environment/environmentManager';
import { readAuditEntry, Decoder, REMOTE_SEQUENCE_UPDATE } from '../../resources/auditStore';
import { HAS_STRUCTURE_UPDATE } from '../../resources/RecordEncoder';
import { CERT_PREFERENCE_REP } from '../../utility/terms/certificates';
import { addSubscription } from '../../resources/transactionBroadcast';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { threadId } from 'worker_threads';
import * as logger from '../../utility/logging/harper_logger';
import { disconnectedFromNode, connectedToNode, getHDBNodeTable } from './subscriptionManager';
import { EventEmitter } from 'events';
import { rootCertificates } from 'node:tls';
import { broadcast } from '../../server/threads/manageThreads';
import * as https from 'node:https';
import * as tls from 'node:tls';
//import { operation } from '../../server/serverHelpers/serverUtilities';

const SUBSCRIBE_CODE = 129;
const SEND_NODE_NAME = 140;
const SEND_ID_MAPPING = 141;
const DISCONNECT = 142;
const SEND_RESIDENCY_LIST = 130;
const SEND_TABLE_STRUCTURE = 131;
const SEND_TABLE_FIXED_STRUCTURE = 132;
export const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const COMMITTED_UPDATE = 143;
export const table_update_listeners = new Map();
export const database_subscriptions = new Map();
const DEBUG_MODE = true;
const PING_INTERVAL = 300000;
export let awaiting_response = new Map();
/**
 * Handles reconnection, and requesting catch-up
 */

export async function createWebSocket(url, options?) {
	const { authorization, rejectUnauthorized } = options || {};
	const private_key = env.get('tls_privateKey');
	const certificate_authorities = new Set();
	let cert;
	if (url.includes('wss://')) {
		for await (const node of databases.system.hdb_nodes.search([])) {
			if (node.ca) {
				certificate_authorities.add(node.ca);
			}
		}
		let cert_quality = 0;
		for await (const certificate of databases.system.hdb_certificate.search([])) {
			let quality = CERT_PREFERENCE_REP[certificate.name];
			if (quality > cert_quality) {
				cert = certificate.certificate;
			}
		}
		if (!cert && rejectUnauthorized !== false) {
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
	let node_name = getThisNodeName();
	return new WebSocket(url, 'harperdb-replication-v1', {
		headers,
		key: readFileSync(private_key),
		ciphers: env.get('tls_ciphers'),
		rejectUnauthorized: true,
		localAddress: node_name?.startsWith('127.0') ? node_name : undefined,
		noDelay: true,
		cert,
		// for client connections, we can add our certificate authority to the root certificates
		// to authorize the server certificate (both public valid certificates and privately signed certificates are acceptable)
		ca: [...rootCertificates, ...certificate_authorities],
		// we set this very high (16x times the default) because it can be a bit expensive to switch back and forth
		// between push and pull mode
		highWaterMark: 256 * 1024,
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
			if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
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
	let last_sequence_id_received;
	const this_node_url = env.get('replication_url');
	let send_ping_interval, receive_ping_timer, last_ping_time;
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
	const residency_map = [];
	const sent_residency_lists = [];
	const received_residency_lists = [];
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
					case SEND_NODE_NAME: {
						if (remote_node_name) {
							if (remote_node_name !== data) {
								logger.error(
									connection_id,
									`Node name mismatch, expecting to connect to ${remote_node_name}, but server reported name as ${data}, disconnecting`
								);
								ws.send(encode([DISCONNECT]));
								close(1008, 'Node name mismatch');
								return;
							}
						} else remote_node_name = data;
						if (options.connection) options.connection.nodeName = remote_node_name;
						const url = message[3] ?? this_node_url;
						logger.info(connection_id, 'received node id', remote_node_name, database_name);
						if (!database_name) {
							if (!setDatabase((database_name = message[2]))) {
								// if this fails, we should close the connection and indicate that we should not reconnect
								ws.send(encode([DISCONNECT]));
								close(1008, 'Database name mismatch');
								return;
							}
						}
						logger.info(connection_id, 'setDatabase', database_name, tables && Object.keys(tables));
						sendSubscriptionRequestUpdate();
						break;
					}
					case DISCONNECT:
						close();
						break;
					case OPERATION_REQUEST:
						try {
							server.operation(data, { user: authorization }, true).then(
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
					case SEND_TABLE_FIXED_STRUCTURE:
						const table_name = message[3];
						if (!tables) {
							if (database_name) logger.error(connection_id, 'No tables found for', database_name);
							else logger.error(connection_id, 'Database name never received');
						}
						let table = tables[table_name];
						if (!table) {
							// TODO: Do we need to check if we are replicating everything by default?
							table = ensureTable({ table: table_name, database: database_name, attributes: data.attributes });
							logger.error(connection_id, 'Table not found', table_name, 'creating');
						}
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
					case SEND_ID_MAPPING:
						remote_short_id_to_local_id = remoteToLocalNodeId(remote_node_name, data, audit_store);
						break;
					case SEND_RESIDENCY_LIST:
						const residency_id = table_id;
						received_residency_lists[residency_id] = data;
						break;
					case COMMITTED_UPDATE:
						// we need to record the sequence number that the remote node has received
						broadcast({
							type: 'replicated',
							database: database_name,
							node: remote_node_name,
							time: data,
						});
						break;
					case SUBSCRIBE_CODE:
						const [action, db, , , node_subscriptions] = message;
						// permission check to make sure that this node is allowed to subscribe to this database, that is that
						// we have publish permission for this node/database
						if (
							!(
								authorization.publish ||
								authorization.subscriptions?.some(
									// TODO: Verify the table permissions for each table listed in the subscriptions
									(sub) => (sub.database || sub.schema) === database_name && sub.publish
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
						const table_by_id = table_subscription_to_replicator.tableById.map((table) => {
							if (
								first_node.replicateByDefault
									? !first_node.tables.includes(table.tableName)
									: first_node.tables.includes(table.tableName)
							) {
								first_table = table;
								return { table };
							}
						});
						const subscribed_node_ids = [];
						for (let { name, startTime } of node_subscriptions) {
							const local_id = getIdOfRemoteNode(name, audit_store);
							subscribed_node_ids[local_id] = startTime;
						}
						ws.send(encode([SEND_ID_MAPPING, exportIdMapping(table_subscription_to_replicator.auditStore)]));
						const encoder = new Encoder();
						const current_transaction = { txnTime: 0 };
						let listening_for_overload = false;
						let current_sequence_id = Infinity; // the last sequence number we have sent, set this with a finite number from the subscriptions
						const sendAuditRecord = (record_id, audit_record, local_time, begin_txn) => {
							current_sequence_id = local_time;
							// TOOD: Use begin_txn instead to find transaction delimiting
							if (audit_record.type === 'end_txn') {
								if (current_transaction.txnTime) {
									if (DEBUG_MODE) logger.info(connection_id, 'sending replication message', encoding_start, position);
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error('Invalid encoding of message');
									}
									writeInt(9); // replication message of nine bytes long
									writeInt(REMOTE_SEQUENCE_UPDATE); // action id
									writeFloat64(local_time); // send the local time so we know what sequence number to start from next time.
									sendQueuedDataWithBackPressure();
								}
								encoding_start = position;
								current_transaction.txnTime = 0;
								return; // end of transaction, nothing more to do
							}
							const node_id = audit_record.nodeId;
							const table_id = audit_record.tableId;
							const table_entry = table_by_id[table_id];
							if (!table_entry) {
								return logger.trace('Not subscribed to table', table_id);
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
									sendQueuedDataWithBackPressure();
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
										SEND_TABLE_FIXED_STRUCTURE,
										{ typedStructs: typed_structs, structures: structures, attributes: table.attributes },
										table_id,
										table_entry.table.tableName,
									])
								);
							}
							if (residency_id && !sent_residency_lists[residency_id]) {
								ws.send(encode([SEND_RESIDENCY_LIST, residency, residency_id]));
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
						const sendQueuedDataWithBackPressure = () => {
							// check first if we are overloaded, if so, we send and then go into pull mode so that we can wait for the drain event
							if (listening_for_overload && ws._socket.writableNeedDrain) {
								// we are overloaded, so we need to stop sending and wait for the drain event
								logger.info(connection_id, 'overloaded, will wait for drain');
								listening_for_overload = false;
								audit_subscription.end();
								audit_subscription.emit('overloaded');
							}
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
										if (ws._socket.writableNeedDrain) await new Promise((resolve) => ws._socket.once('drain', resolve));
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
								listening_for_overload = true;
								audit_subscription = addSubscription(
									first_table,
									null,
									sendAuditRecord,
									current_sequence_id,
									'full-database'
								);
								audit_subscription.on('close', () => {
									closed = true;
								});
								let listeners = table_update_listeners.get(first_table);
								if (!listeners) table_update_listeners.set(first_table, (listeners = []));
								listeners.push((table) => {
									// TODO: send table update
								});
								await new Promise((resolve) => {
									// continue loop back to for loop if we encounter too much back-pressure
									audit_subscription.on('overloaded', resolve);
								});
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
			do {
				/*const table_id = decoder.readInt();
				const key_length = decoder.readInt();
				const record_key = readKey(body, decoder.position, (decoder.position += key_length));*/
				const event_length = decoder.readInt();
				if (event_length === 9 && decoder.getUint8(decoder.position) == REMOTE_SEQUENCE_UPDATE) {
					decoder.position++;
					last_sequence_id_received = decoder.readFloat64();
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
					table: table_decoders[audit_record.tableId].name,
					id: audit_record.recordId,
					type: audit_record.type,
					nodeId: remote_short_id_to_local_id.get(audit_record.nodeId),
					residencyList: residency_list,
					timestamp: audit_record.version,
					value: audit_record.getValue(table_decoders[audit_record.tableId]),
					user: audit_record.user,
					beginTxn: begin_txn,
				};
				if (begin_txn) {
					event.onCommit = () => {
						// we need to wait for the commit message before we can send confirmation
						audit_record.lo;
					};
				}
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
			table_subscription_to_replicator.send({
				type: 'end_txn',
				localTime: last_sequence_id_received,
				remoteNode: remote_node_name,
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
			const table_subs = [];
			for (let table_name in tables) {
				if (node.replicateByDefault ? tables[table_name].replicate === false : tables[table_name].replicate)
					table_subs.push(table_name);
			}

			return {
				name: node.name,
				replicateByDefault: node.replicateByDefault,
				tables: table_subs, // omitted or included based on flag above
				startTime: (table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), node.name]) ?? 10001) - 10000,
			};
		});
		logger.info(
			connection_id,
			'sending subscription request',
			node_subscriptions,
			table_subscription_to_replicator.dbisDB.path
		);

		if (node_subscriptions) {
			// no nodes means we are unsubscribing
			ws.send(encode([SUBSCRIBE_CODE, database_name, last_sequence_id_received, null, node_subscriptions]));
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
			logger.error(`No database named "${database_name}" was declared and registered`);
			return false;
		}
		audit_store = table_subscription_to_replicator.auditStore;
		if (!audit_store) {
			logger.error('No audit store found in ' + database_name);
			return;
		}
		if (!tables) tables = getDatabases()?.[database_name];

		const this_node_name = getThisNodeName();
		if (this_node_name === remote_node_name) {
			if (!this_node_name) logger.error('Node name not defined');
			else logger.error('Should not connect to self', this_node_name);
			return false;
		}
		logger.info('Sending node name', this_node_name, 'database name', database_name);
		ws.send(encode([SEND_NODE_NAME, this_node_name, database_name, this_node_url]));
		return true;
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
