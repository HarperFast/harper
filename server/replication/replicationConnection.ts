import {getDatabases} from '../../resources/databases';
import {Decoder, readAuditEntry} from '../../resources/auditStore';
import {exportIdMapping, getIdOfRemoteNode, getNodeName, remoteToLocalNodeId} from './nodeIdMapping';
import {addSubscription} from '../../resources/transactionBroadcast';
import {active_subscriptions, addNodeSubscription, removeNodeSubscription} from './activeSubscriptions';
import env from '../../utility/environment/environmentManager';
import { readAuditEntry, Decoder } from '../../resources/auditStore';
import { readKey, writeKey } from 'ordered-binary';
import { addSubscription } from '../../resources/transactionBroadcast';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { active_subscriptions, addNodeSubscription, removeNodeSubscription } from './activeSubscriptions';
import { exportIdMapping, getNodeName, remoteToLocalNodeId, getIdOfRemoteNode } from './nodeIdMapping';
import { threadId } from 'worker_threads';

const SUBSCRIBE_CODE = 129;
const SEND_NODE_ID = 140;
const SEND_ID_MAPPING = 141;
const SEND_TABLE_NAME = 130;
const SEND_TABLE_STRUCTURE = 131;
const SEND_TABLE_FIXED_STRUCTURE = 132;
const table_update_listeners = new Map();
export const database_subscriptions = new Map();


/**
 * Handles reconnection, and requesting catch-up
 */
export class NodeReplicationConnection {
	socket: WebSocket;
	startTime: number;
	retryTime = 200;
	retries = 0;
	constructor(public url, public subscription, public databaseName) {}
	connect() {
		const tables = [];
		// TODO: Need to do this specifically for each node
		const private_key = env.get('tls_privateKey');
		const certificate = env.get('tls_certificate');
		const certificate_authority = env.get('tls_certificateAuthority');
		this.socket = new WebSocket(this.url, {
			protocols: 'harperdb-replication',
			key: readFileSync(private_key),
			ciphers: env.get('tls_ciphers'),
			cert: readFileSync(certificate),
			ca: certificate_authority && readFileSync(certificate_authority),
		});
		let replicator;
		this.socket.on('open', () => {
			console.log('connected to ' + this.url);
			this.retries = 0;
			this.retryTime = 200;
			replicator = replicateOverWS(this.socket, {
				database: this.databaseName,
				subscription: this.subscription,
				url: this.url,
			});
		});
		this.socket.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED')
				console.error('Error in connection to ' + this.url, error.message);
		});

		this.socket.on('close', () => {
			if (++this.retries % 20 === 1)
				console.warn(`disconnected from ${this.url} (db: "${this.databaseName})`);
			replicator?.end();

			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, this.retryTime).unref();
			this.retryTime += this.retryTime >> 3; // increase by 12% each time
		});
	}
	send(message) {}
}

/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
export function replicateOverWS(ws, options) {
	const connection_id = threadId + (options.url ? 'c:' + options.url.slice(-4) : 's:' + options.port) + ' ' + Math.random().toString().slice(2,3);
	console.log(connection_id, 'registering');

	let encoding_start = 0;
	let encoding_buffer = Buffer.allocUnsafeSlow(1024);
	let position = 0;
	let data_view = new DataView(encoding_buffer.buffer, 0, 1024);
	let database_name = options.database;
	const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
	let audit_store;
	// this is the subscription that the local table makes to this replicator, and incoming messages
	// are sent to this subscription queue:
	let incoming_subscription = options.subscription;
	let tables = options.tables || (database_name && getDatabases()[database_name]);
	if (database_name) setDatabase(database_name);
	const table_decoders = [];
	const omitted_node_ids = [];
	let subscription_request, audit_subscription;
	let remote_node_name;
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
					case SEND_NODE_ID: {
						// data is the map of its mapping of node name/guid to short ids
						remote_node_name = message[1];
						console.log(connection_id, 'received node id', remote_node_name, database_name);
						if (!database_name) setDatabase((database_name = message[2]));
						console.log(connection_id, 'setDatabase', database_name, tables && Object.keys(tables));
						sendSubscriptionRequestUpdate();
						// TODO: Listen to adc
						break;
					}
					case SEND_TABLE_FIXED_STRUCTURE:
						const table_name = message[3];
						if (!tables) {
							if (database_name) console.error(connection_id, 'No tables found for', database_name);
							else console.error(connection_id, 'Database name never received');
						}
						const table = tables[table_name];
						if (!table) {
							// TODO: We may want to create a table on the fly
							console.error(connection_id, 'Table not found', table_name);
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
					case SUBSCRIBE_CODE:
						const [action, db, start_time, table_ids, remote_omitted_node_names] = message;
						/*const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
						const db_length = body[1];
						const database_name = body.toString('utf8', 2, db_length + 2);
						const start_time = decoder.getFloat64(2 + db_length);*/
						if (incoming_subscription) {
							if (database_name !== incoming_subscription.databaseName) {
								console.error(
									'Subscription request for wrong database',
									database_name,
									incoming_subscription.databaseName
								);
								return;
							}
						} else incoming_subscription = db_subscriptions.get(database_name);
						console.log(connection_id, 'received subscription request for', database_name, 'at', start_time, 'omitting', remote_omitted_node_names);
						if (audit_subscription) {
							console.log(connection_id, 'stopping previous subscription', database_name, start_time);
							audit_subscription.emit('close');
						}
						if (start_time === Infinity) // use to unsubscribe
							return;
						let first_table;
						const table_by_id = incoming_subscription.tableById.map((table) => {
							first_table = table;
							return { table };
						});
						const omitted_node_ids = [getIdOfRemoteNode(remote_node_name, audit_store)]; // we always omit the node that we are receiving from, don't want to echo
						// and we also omit any other nodes that they indicate that we should omit (that they are already subscribed to)
						remote_omitted_node_names.map((node_name) => {
							omitted_node_ids.push(getIdOfRemoteNode(node_name, audit_store));
						});
						ws.send(encode([SEND_ID_MAPPING, exportIdMapping(incoming_subscription.auditStore)]));
						const encoder = new Encoder();
						const current_transaction = { txnTime: 0 };
						const sendAuditRecord = (audit_record, local_time) => {
							if (!audit_record) {
								if (current_transaction.txnTime) {
									console.log(connection_id, 'sending replication message', encoding_start, position);
									ws.send(encoding_buffer.subarray(encoding_start, position));
								}
								encoding_start = position;
								current_transaction.txnTime = 0;
								return; // end of transaction, nothing more to do
							}
							const node_id = audit_record.nodeId;
							if (omitted_node_ids.includes(node_id)) {
								console.log(connection_id, 'skipping replication update', audit_record.recordId, 'to:', remote_node_name, 'from:', node_id, 'omitted:', omitted_node_ids)
								return;
							}
							console.log(connection_id, 'preparing replication update', audit_record.recordId, 'to:', remote_node_name, 'from:', node_id, 'omitted:', omitted_node_ids)
							const table_id = audit_record.tableId;
							const txn_time = audit_record.version;
							const encoded = audit_record.encoded;
							if (current_transaction.txnTime !== txn_time) {
								// send the queued transaction
								if (current_transaction.txnTime) {
									console.log('new txn time, sending queued txn', current_transaction.txnTime);
									ws.send(encoding_buffer.subarray(encoding_start, position));
								}
								current_transaction.txnTime = txn_time;
								encoding_start = position;
								writeFloat64(txn_time);
							} /*
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
							const start = audit_record.encoded[0] === 66 ? 8 : 0;
							writeInt(audit_record.encoded.length - start);
							writeBytes(audit_record.encoded, start);
							const table_entry = table_by_id[table_id];
							const typed_structs = table_entry.table.primaryStore.encoder.typedStructs;
							if (typed_structs.length != table_entry.typed_length) {
								table_entry.typed_length = typed_structs.length;
								console.log(connection_id, 'send table struct');
								if (!table_entry.sentName) {
									// TODO: only send the table name once
									table_entry.sentName = true;
								}
								ws.send(encode([SEND_TABLE_FIXED_STRUCTURE, typed_structs, table_id, table_entry.table.tableName]));
							}
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
							let sent_records = false;
							for (const { key, value: audit_entry } of audit_store.getRange({
								start: start_time || 1,
								exclusiveStart: true,
								snapshot: false, // don't want to use a snapshot, and we want to see new entries
							})) {
								if (closed) return;
								const audit_record = readAuditEntry(audit_entry);
								sendAuditRecord(audit_record, key);
								sent_records = true;
								// TODO: Need to do this with back-pressure, but would need to catch up on anything published during iteration
								//await rest(); // yield for fairness
								audit_subscription.startTime = key; // update so don't double send
							}
							if (sent_records) sendAuditRecord(null, 0);
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
				const start = decoder.position;
				const audit_record = readAuditEntry(body);
				const event = {
					table: table_decoders[audit_record.tableId].name,
					id: audit_record.recordId,
					type: audit_record.type,
					nodeId: remote_short_id_to_local_id.get(audit_record.nodeId),
					timestamp: audit_record.version,
					value: audit_record.getValue(table_decoders[audit_record.tableId]),
					user: audit_record.user,
					beginTxn: begin_txn,
				};
				begin_txn = false;
				// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
				console.log(connection_id, 'received replication message, id:', event.id, 'version:', audit_record.version, 'nodeId', event.nodeId, 'name', event.value.name);
				incoming_subscription.send(event);
				decoder.position = start + event_length;
			} while (decoder.position < body.byteLength);
			incoming_subscription.send({ type: 'end_txn' });
		} catch (error) {
			console.error(connection_id, 'Error handling incoming replication message', error);
		}
	});
	function sendSubscriptionRequestUpdate(existing_listener) {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		let node_subscriptions = active_subscriptions.get(database_name);
		if (!node_subscriptions) active_subscriptions.set(database_name, (node_subscriptions = new Map()));
		let subscription = node_subscriptions.get(remote_node_name);
		if (!subscription || subscription.listener === existing_listener) {
			const omitted_node_names = [];
			for (const [node_name] of node_subscriptions) {
				if (node_name !== remote_node_name) omitted_node_names.push(node_name);
			}
			const onSubscriptionUpdate = () => {
				// The subscription list has changed, we either need to unsubscribe if another thread has taken over
				// or add a node id to our list of omitted node ids, so we rerun this to recompute our new subscription (or lack thereof)
				sendSubscriptionRequestUpdate(onSubscriptionUpdate);
			};
			if (!subscription)
				addNodeSubscription(database_name, remote_node_name, onSubscriptionUpdate);
			ws.send(encode([SUBSCRIBE_CODE, database_name, options.startTime, null, omitted_node_names]));
			console.log(connection_id, (existing_listener ? 'resent' : 'sent') + ' subscription request to', remote_node_name, 'for', database_name, 'omitting', omitted_node_names);
			subscription_request = {
				end() {
					removeNodeSubscription(database_name, remote_node_name);
				},
			};
		} else {
			if (existing_listener)
				ws.send(encode([SUBSCRIBE_CODE, database_name, Infinity, null, []]));
			console.log(connection_id, (existing_listener ? 'removing subscription ' : 'already subscribed to'), database_name, remote_node_name);
		}
	}
	function setDatabase(database_name) {
		incoming_subscription = incoming_subscription || db_subscriptions.get(database_name);
		if (!incoming_subscription) {
			console.error(`No database named "${database_name}" was declared and registered`);
			return;
		}
		audit_store = incoming_subscription.auditStore;
		if (!audit_store) {
			console.error('No audit store found in ' + database_name);
			return;
		}
		if (!tables) tables = (options.database || getDatabases() || {})[database_name];

		const this_node_name = getNodeName(audit_store);
		ws.send(encode([SEND_NODE_ID, this_node_name, database_name]));
	}
	return {
		end() {
			// cleanup
			if (subscription_request) subscription_request.end();
			if (audit_subscription) audit_subscription.emit('close');
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
		if (length + 11 > encoding_buffer.length - position) {
			const new_buffer = Buffer.allocUnsafeSlow(((length + 4096) >> 10) << 11);
			encoding_buffer.copy(new_buffer, encoding_start);
			position = position - encoding_start;
			encoding_start = 0;
			encoding_buffer = new_buffer;
			data_view = new DataView(encoding_buffer.buffer, 0, encoding_buffer.length);
		}
		src.copy(encoding_buffer, position, start, end);
		position += length;
	}
	function writeFloat64(number) {
		if (8 > encoding_buffer.length - position) {
			const new_buffer = Buffer.allocUnsafeSlow(4096);
			encoding_buffer.copy(new_buffer, encoding_start);
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
