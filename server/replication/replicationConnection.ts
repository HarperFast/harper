import { getDatabases } from '../../resources/databases';
import {
	createAuditEntry,
	Decoder,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	readAuditEntry,
} from '../../resources/auditStore';
import { exportIdMapping, getIdOfRemoteNode, remoteToLocalNodeId } from './nodeIdMapping';
import { addSubscription } from '../../resources/transactionBroadcast';
import {
	active_subscriptions,
	addNodeSubscription,
	removeNodeSubscription,
	updatedRoutingForNode,
} from './activeSubscriptions';
import { getThisNodeName } from './replicator';
import env from '../../utility/environment/environmentManager';
import { readAuditEntry, Decoder, REMOTE_SEQUENCE_UPDATE } from '../../resources/auditStore';
import { HAS_STRUCTURE_UPDATE } from '../../resources/RecordEncoder';
import { readKey, writeKey } from 'ordered-binary';
import { addSubscription } from '../../resources/transactionBroadcast';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { active_subscriptions, addNodeSubscription, removeNodeSubscription } from './activeSubscriptions';
import { threadId } from 'worker_threads';
import * as logger from '../../utility/logging/harper_logger';
import { disconnectedFromNode, ensureNode } from './subscriptionManager';
import { EventEmitter } from 'events';

const SUBSCRIBE_CODE = 129;
const SEND_NODE_NAME = 140;
const SEND_ID_MAPPING = 141;
const DISCONNECT = 142;
const SEND_RESIDENCY_LIST = 130;
const SEND_TABLE_STRUCTURE = 131;
const SEND_TABLE_FIXED_STRUCTURE = 132;
export const table_update_listeners = new Map();
export const database_subscriptions = new Map();
const DEBUG_MODE = true;

/**
 * Handles reconnection, and requesting catch-up
 */
export class NodeReplicationConnection extends EventEmitter {
	socket: WebSocket;
	startTime: number;
	retryTime = 200;
	retries = 0;
	nodeSubscriptions: Map<string, number>;
	constructor(public url, public subscription, public databaseName) {
		super();
	}

	connect() {
		const tables = [];
		// TODO: Need to do this specifically for each node
		const private_key = env.get('tls_privateKey');
		const certificate = env.get('tls_certificate'); // this is the client certificate, usually not the same location as the server certificate
		const certificate_authority = env.get('tls_certificateAuthority');
		this.socket = new WebSocket(this.url, {
			protocols: 'harperdb-replication-v1',
			key: readFileSync(private_key),
			ciphers: env.get('tls_ciphers'),
			cert: readFileSync(certificate),
			ca: certificate_authority && readFileSync(certificate_authority),
		});

		let session;
		this.socket.on('open', () => {
			logger.info('connected to ' + this.url);
			this.retries = 0;
			this.retryTime = 200;
			session = replicateOverWS(this.socket, {
				database: this.databaseName,
				subscription: this.subscription,
				url: this.url,
				connection: this,
			});
		});
		this.socket.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
		});

		this.socket.on('close', () => {
			if (this.socket.isFinished) {
				session.end();
				return;
			}
			session?.disconnected();
			if (++this.retries % 20 === 1) {
				logger.warn(`disconnected from ${this.url} (db: "${this.databaseName}")`);
			}
			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, this.retryTime).unref();
			this.retryTime += this.retryTime >> 3; // increase by 12% each time
		});
	}
	subscribe(node_subscriptions) {
		this.nodeSubscriptions = node_subscriptions;
		this.emit('subscriptions-updated', node_subscriptions);
	}

	send(message) {}
}

/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
export function replicateOverWS(ws, options) {
	const connection_id =
		(process.pid % 1000) +
		'-' +
		threadId +
		(options.port ? 's:' + options.port : 'c:' + options.url.slice(-4)) +
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
	let remote_node_name;
	let last_local_time;
	const this_node_url = env.get('replication_url');

	if (database_name) {
		setDatabase(database_name);
		sendSubscriptionRequestUpdate();
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
						remote_node_name = message[1];
						const url = message[3] ?? this_node_url;
						if (url) {
							// make sure we have a node for this name and url
							ensureNode(remote_node_name, url);
							// TODO: If there is an existing node with this URL that has never connected, we should update it
						}
						logger.info(connection_id, 'received node id', remote_node_name, database_name);
						if (!database_name) {
							if (!setDatabase((database_name = message[2]))) {
								// if this fails, we should close the connection and indicate that we should not reconnect
								ws.isFinished = true;
								ws.send(encode([DISCONNECT]));
								ws.close();
								return;
							}
						}
						logger.info(connection_id, 'setDatabase', database_name, tables && Object.keys(tables));
						break;
					}
					case DISCONNECT:
						ws.isFinished = true;
						ws.close();
						break;
					case SEND_TABLE_FIXED_STRUCTURE:
						const table_name = message[3];
						if (!tables) {
							if (database_name) logger.error(connection_id, 'No tables found for', database_name);
							else logger.error(connection_id, 'Database name never received');
						}
						const table = tables[table_name];
						if (!table) {
							// TODO: We may want to create a table on the fly
							logger.error(connection_id, 'Table not found', table_name);
						}
						table_decoders[table_id] = {
							name: table_name,
							decoder: new Packr({
								useBigIntExtension: true,
								randomAccessStructure: true,
								freezeData: true,
								typedStructs: data,
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
					case SUBSCRIBE_CODE:
						const [action, db, start_time, table_ids, node_subscriptions] = message;
						/*const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
						const db_length = body[1];
						const database_name = body.toString('utf8', 2, db_length + 2);
						const start_time = decoder.getFloat64(2 + db_length);*/
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
						if (audit_subscription) {
							logger.info(connection_id, 'stopping previous subscription', database_name, start_time);
							audit_subscription.emit('close');
						}
						if (start_time === Infinity)
							// use to unsubscribe
							return;
						let first_table;
						const table_by_id = table_subscription_to_replicator.tableById.map((table) => {
							first_table = table;
							return { table };
						});
						const subscribed_node_ids = node_subscriptions.map(({ name }) => {
							return getIdOfRemoteNode(name, audit_store);
						});
						ws.send(encode([SEND_ID_MAPPING, exportIdMapping(table_subscription_to_replicator.auditStore)]));
						const encoder = new Encoder();
						const current_transaction = { txnTime: 0 };
						const sendAuditRecord = (record_id, audit_record, local_time, begin_txn) => {
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
									ws.send(encoding_buffer.subarray(encoding_start, position));
								}
								encoding_start = position;
								current_transaction.txnTime = 0;
								return; // end of transaction, nothing more to do
							}
							const node_id = audit_record.nodeId;
							const table_id = audit_record.tableId;
							const table_entry = table_by_id[table_id];
							if (!table_entry) {
								return logger.error('Invalid table id', table_id);
							}
							const table = table_entry.table;
							let primary_store = table.primaryStore;
							let encoder = primary_store.encoder;
							if (audit_record.extendedType & HAS_STRUCTURE_UPDATE || !encoder.typedStructs) {
								// there is a structure update, fully load the entire record so it is all loaded into memory
								const value = audit_record.getValue(primary_store, true);
								JSON.stringify(value);
							}
							if (!subscribed_node_ids.includes(node_id)) {
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
									if (DEBUG_MODE) logger.info('new txn time, sending queued txn', current_transaction.txnTime);
									if (encoding_buffer[encoding_start] !== 66) {
										logger.error('Invalid encoding of message');
									}
									ws.send(encoding_buffer.subarray(encoding_start, position));
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
								logger.info(connection_id, 'send table struct');
								if (!table_entry.sentName) {
									// TODO: only send the table name once
									table_entry.sentName = true;
								}
								ws.send(encode([SEND_TABLE_FIXED_STRUCTURE, typed_structs, table_id, table_entry.table.tableName]));
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

						audit_subscription = addSubscription(first_table, null, sendAuditRecord, start_time, 'full-database');
						let listeners = table_update_listeners.get(first_table);
						if (!listeners) table_update_listeners.set(first_table, (listeners = []));
						listeners.push((table) => {
							// TODO: send table update
						});
						let closed = false;
						audit_subscription.on('close', () => {
							closed = true;
						});
						if (start_time) {
							let last_sequence = 0;
							for (const { key, value: audit_entry } of audit_store.getRange({
								start: start_time || 1,
								exclusiveStart: true,
								snapshot: false, // don't want to use a snapshot, and we want to see new entries
							})) {
								if (closed) return;
								last_sequence = key;
								const audit_record = readAuditEntry(audit_entry);
								sendAuditRecord(null, audit_record, key);
								// TODO: Need to do this with back-pressure, but would need to catch up on anything published during iteration
								//await rest(); // yield for fairness
								audit_subscription.startTime = key; // update so don't double send
							}
							if (last_sequence)
								sendAuditRecord(null, {
									type: 'end_txn',
									localTime: last_sequence,
									remoteNode: remote_node_name,
								});
						}
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
					last_local_time = decoder.readFloat64();
					logger.info('received remote sequence update', last_local_time);
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
				localTime: last_local_time,
				remoteNode: remote_node_name,
			});
		} catch (error) {
			logger.error(connection_id, 'Error handling incoming replication message', error);
		}
	});
	ws.on('close', () => {
		if (audit_subscription) audit_subscription.emit('close');
		if (subscription_request) subscription_request.end();
		logger.info(connection_id, 'closed');
	});

	function recordRemoteNodeSequence() {}
	function sendSubscriptionRequestUpdate(existing_listener) {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		if (!subscribed) {
			subscribed = true;
			options.connection.on('subscriptions-updated', sendSubscriptionRequestUpdate);
		}
		if (!last_local_time) {
			last_local_time = table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), remote_node_name]);
			logger.info(
				connection_id,
				'requesting to start from',
				last_local_time,
				remote_node_name,
				table_subscription_to_replicator.dbisDB.path
			);
		}
		const node_subscriptions = options.connection?.nodeSubscriptions.map((node, index) => {
			return {
				name: node.name,
				startTime:
					index == 0
						? last_local_time
						: table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), node.name]) - 10000,
			};
		});
		ws.send(encode([SUBSCRIBE_CODE, database_name, last_local_time, null, node_subscriptions]));

		return;

		//let node_subscriptions = active_subscriptions.get(database_name);
		if (!node_subscriptions) active_subscriptions.set(database_name, (node_subscriptions = new Map()));
		let subscription = node_subscriptions.get(remote_node_name);
		if (
			!subscription ||
			subscription.listener === existing_listener ||
			(subscription.threadId === threadId && !subscription.listener)
		) {
			const additional_node_names = subscription.additionalNodes;
			for (const [node_name] of node_subscriptions) {
				if (node_name !== remote_node_name) additional_node_names.push(node_name);
			}
			const onSubscriptionUpdate = () => {
				// The subscription list has changed, we either need to unsubscribe if another thread has taken over
				// or add a node id to our list of omitted node ids, so we rerun this to recompute our new subscription (or lack thereof)
				sendSubscriptionRequestUpdate(onSubscriptionUpdate);
			};
			if (!subscription) addNodeSubscription(database_name, remote_node_name, onSubscriptionUpdate);
			if (
				existing_listener &&
				JSON.stringify(existing_listener.additionalNodes) === JSON.stringify(additional_node_names)
			) {
				logger.info(connection_id, 'subscription checked, no changes needed');
				return; // no changes needed
			} else if (existing_listener) {
				logger.info(
					'sub difference',
					JSON.stringify(existing_listener.additionalNodes),
					JSON.stringify(additional_node_names)
				);
			}
			onSubscriptionUpdate.additionalNodes = additional_node_names;
			if (!last_local_time) {
				last_local_time = table_subscription_to_replicator.dbisDB.get([Symbol.for('seq'), remote_node_name]);
				logger.info(
					connection_id,
					'requesting to start from',
					last_local_time,
					remote_node_name,
					table_subscription_to_replicator.dbisDB.path
				);
			}
			ws.send(encode([SUBSCRIBE_CODE, database_name, last_local_time, null, additional_node_names]));
			logger.info(
				connection_id,
				(existing_listener ? 'resent' : 'sent') + ' subscription request to',
				remote_node_name,
				'for',
				database_name,
				'omitting',
				additional_node_names
			);
			subscription_request = {
				end() {
					logger.info(connection_id, 'removing subscription', database_name, remote_node_name);
					removeNodeSubscription(database_name, remote_node_name);
				},
			};
		} else {
			if (existing_listener) ws.send(encode([SUBSCRIBE_CODE, database_name, Infinity, null, []]));
			logger.info(
				connection_id,
				existing_listener ? 'removing subscription ' : 'already subscribed to',
				database_name,
				remote_node_name
			);
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
			logger.error('Should not connect to self', this_node_name);
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
			});
			// TODO: When we get reconnected, we need to undo this
		},
	};

	function writeInt(number) {
		if (number < 128) {
			encoding_buffer[position++] = number;
		} else if (number < 0x4000) {
			data_view.setUint16(position, number | 0x7fff);
			position += 2;
		} else if (number < 0x3f000000) {
			data_view.setUint32(position, number | 0xcfffffff);
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
