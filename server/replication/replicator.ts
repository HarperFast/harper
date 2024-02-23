/**
 * This module is responsible for replicating data between nodes. It is a source for tables that are replicated
 * A typical exchange should look like:
 * 1. Node A connects to node B, and sends its node name and the database name (and the mapping of its node id to short ids?)
 * 2. Node B sends back its node name and the mapping of its node id to short ids
 * 3. Node A sends a subscription request to node B
 * 3a. Node B may also send a subscription request to node A
 * 4. Node B sends back the table names and structures
 * 5. Node B sends back the audit records
 */

import { table as defineTable, getDatabases, onUpdatedTable } from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { getWorkerIndex } from '../threads/manageThreads';
import env from '../../utility/environment/environmentManager';
import hdb_terms from '../../utility/hdbTerms';
import * as harper_logger from '../../utility/logging/harper_logger';
import { Context } from '../../resources/ResourceInterface';
import { readAuditEntry, Decoder } from '../../resources/auditStore';
import { readKey, writeKey } from 'ordered-binary';
import { addSubscription } from '../../resources/transactionBroadcast';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { server } from '../Server';
import { readFileSync } from 'fs';
import { active_subscriptions, addNodeSubscription } from './activeSubscriptions';
import { exportIdMapping, getNodeName, remoteToLocalNodeId } from './nodeIdMapping';

const SUBSCRIBE_CODE = 129;
const SEND_NODE_ID = 140;
const SEND_ID_MAPPING = 141;
const SEND_TABLE_NAME = 130;
const SEND_TABLE_STRUCTURE = 131;
const SEND_TABLE_FIXED_STRUCTURE = 132;
const table_update_listeners = new Map();
let replication_disabled;
let node_id;
let node_id_map: Map<string, Map<number, number>>;
const database_subscriptions = new Map();
export function start(options) {
	if (options?.manualAssignment) {
		node_id = options.nodeId;
	} else {
		assignReplicationSource();
		// TODO: node_id should come from the hdb_nodes table
	}
	node_id_map = new Map();
	server.ws(
		(ws, request) => replicateOverWS(ws, options),
		Object.assign(
			// We generally expect this to use the operations API ports (9925)
			{
				protocol: 'harperdb-replication',
				mtls: true,
			},
			options
		)
	);
}
/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
function replicateOverWS(ws, options) {
	console.log('registering', options);
	let database_name = options.database;
	const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
	let audit_store;
	// this is the subscription that the local table makes to this replicator, and incoming messages
	// are sent to this subscription queue:
	let incoming_subscription = options.subscription;
	let tables = options.tables || getDatabases()[database_name] || {};
	if (database_name) setDatabase(database_name);
	const table_decoders = [];
	let omitted_node_ids = [];
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
			console.log('received message on', options.url, 'txn time', body[0]);
			if (body[0] > 127) {
				// not a transaction, special message
				const message = decode(body);
				const [command, data, table_id] = message;
				switch (command) {
					case SEND_NODE_ID: {
						// table_id is the remote node's id
						// data is the map of its mapping of node name/guid to short ids
						remote_node_name = message[1];
						omitted_node_ids = [remote_node_name]; // TODO: This should be an array of all the node names we will omit (should be ignored in the subscription)
						if (!database_name) setDatabase((database_name = message[2]));
						sendSubscriptionRequestUpdate();
						// TODO: Listen to adc
						break;
					}
					case SEND_TABLE_FIXED_STRUCTURE:
						const table_name = message[3];
						const table = tables[table_name];
						if (!table) {
							// TODO: We may want to create a table on the fly
							console.error('Table not found', table_name);
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
						const [action, start_time, table_ids, remote_omitted_node_ids] = message;
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
						console.log('receive subscription request', database_name, start_time, table_ids, options);
						let first_table;
						const table_by_id = incoming_subscription.tableById.map((table) => {
							first_table = table;
							return { table };
						});
						ws.send(encode([SEND_ID_MAPPING, exportIdMapping(incoming_subscription.auditStore)]));
						const encoder = new Encoder();
						const current_transaction = { txnTime: 0 };
						addSubscription(
							first_table,
							null,
							function (audit_record, local_time) {
								if (!audit_record) {
									console.log('No audit record, sending queued txn', current_transaction.txnTime);
									if (current_transaction.txnTime) ws.send(encoding_buffer.subarray(encoding_start, position));
									current_transaction.txnTime = 0;
									return; // end of transaction, nothing more to do
								}
								const node_id = audit_record.nodeId;
								if (omitted_node_ids.includes(node_id)) return;
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
									console.log('send table struct', typed_structs);
									if (!table_entry.sentName) {
										// TODO: only send the table name once
										table_entry.sentName = true;
									}
									ws.send(encode([SEND_TABLE_FIXED_STRUCTURE, typed_structs, table_id, table_entry.table.tableName]));
								}
							},
							start_time,
							'full-database'
						);
						let listeners = table_update_listeners.get(first_table);
						if (!listeners) table_update_listeners.set(first_table, (listeners = []));
						listeners.push((table) => {
							// TODO: send table update
						});
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
				incoming_subscription.send(event);
				decoder.position = start + event_length;
			} while (decoder.position < body.byteLength);
			incoming_subscription.send({ type: 'end_txn' });
		} catch (error) {
			console.error('Error handling incoming replication message', error);
		}
	});
	function sendSubscriptionRequestUpdate() {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		let node_subscriptions = active_subscriptions.get(database_name);
		if (!node_subscriptions) active_subscriptions.set(database_name, (node_subscriptions = new Map()));
		if (!node_subscriptions.has(remote_node_name)) {
			const omitted_node_ids = [];
			for (const [node_id] of node_subscriptions) {
				if (node_id !== remote_node_name) omitted_node_ids.push(node_id);
			}
			addNodeSubscription(database_name, remote_node_name, () => {
				// TODO: The subscription list has changed, we either need to unsubscribe if another thread has taken over
				// or add a node id to our list of omitted node ids
			});
			ws.send(encode([SUBSCRIBE_CODE, database_name, options.startTime, [], omitted_node_ids]));
			console.log('sent subscription', options.url, database_name);
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
}
let encoding_start = 0;
let encoding_buffer = Buffer.allocUnsafeSlow(1024);
let position = 0;
let data_view = new DataView(encoding_buffer.buffer, 0, 1024);
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
		data_view = new DataView(encoding_buffer, 0, encoding_buffer.length);
	}
	src.copy(encoding_buffer, position, start, end);
	position += length;
}
function writeFloat64(number) {
	if (8 > encoding_buffer.length - position) {
		const new_buffer = Buffer.allocUnsafeSlow(((length + 4096) >> 10) << 11);
		encoding_buffer.copy(new_buffer, encoding_start);
		position = position - encoding_start;
		encoding_start = 0;
		encoding_buffer = new_buffer;
		data_view = new DataView(encoding_buffer, 0, encoding_buffer.length);
	}
	data_view.setFloat64(position, number);
	position += 8;
}

class Encoder {
	constructor() {}
}
export function disableReplication(disabled = true) {
	replication_disabled = disabled;
}
const MAX_INGEST_THREADS = 1;
let immediateNATSTransaction, subscribed_to_nodes;
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource(options) {
	if (replication_disabled) return;
	const databases = getDatabases();
	for (const database_name in databases) {
		const database = databases[database_name];
		for (const table_name in database) {
			const Table = database[table_name];
			setReplicator(database_name, Table, options);
		}
	}
	onUpdatedTable((Table, is_changed) => {
		setReplicator(Table.databaseName, Table, options);
		if (is_changed) {
			table_update_listeners.get(Table)?.forEach((listener) => listener(Table));
		}
	});
	if (subscribed_to_nodes) return;
	subscribed_to_nodes = true;
} /*
onMessageFromWorkers((event) => {
	if (event.type === 'nats_update') {
		assignReplicationSource();
	}
});*/

/**
 * Get/create a replication resource that can be assigned as a source to tables
 * @param table_name
 * @param db_name
 */
export function setReplicator(db_name, table, options) {
	if (!table) {
		return console.error(`Attempt to replicate non-existent table ${table.name} from database ${db_name}`);
	}
	if (table.replicated === false || table.Source?.isNATSReplicator) return;
	let source;
	// We may try to consult this to get the other nodes for back-compat
	// const { hub_routes } = getClusteringRoutes();
	table.sourcedFrom(
		class Replicator extends Resource {
			/**
			 * This subscribes to the other nodes. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static async subscribe() {
				const subscription = (this.subscription = new IterableEventQueue());
				const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
				const table_by_id = db_subscriptions.get(db_name)?.tableById || [];
				table_by_id[table.tableId] = table;
				db_subscriptions.set(db_name, subscription);
				subscription.tableById = table_by_id;
				subscription.auditStore = table.auditStore;
				subscription.databaseName = db_name;
				for (const node of options.routes) {
					try {
						const url = node.url;
						// TODO: Do we need to have another way to determine URL?
						// Node subscription also needs to be aware of other nodes that will be excluded from the current subscription
						const connection = new NodeSubscriptionConnection(url, subscription, table.databaseName);
						connection.connect();
					} catch (error) {
						console.error(error);
					}
				}
				return subscription;
			}
			static subscribeOnThisThread(worker_index, total_workers) {
				return worker_index < MAX_INGEST_THREADS;
			}

			connections: NodeSubscriptionConnection[];
			addNode(node_url) {
				this.connections.push(new NodeSubscriptionConnection(node_url, this.subscription));
			}
			static isNATSReplicator = true;
		},
		{ intermediateSource: true }
	);
	/**
	 * This gets the NATS transaction object for the current overall transaction. This will
	 * accumulate any writes that occur during a transaction, and allow them to be aggregated
	 * into a replication message that encompasses all the writes of a transaction.
	 * @param context
	 */
	function getTransaction(context: Context): NATSTransaction {
		let nats_transaction: NATSTransaction = context?.transaction?.nats;
		if (!nats_transaction) {
			if (context?.transaction) {
				context.transaction.push(
					(nats_transaction = context.transaction.nats = new NATSTransaction(context.transaction, context))
				);
				nats_transaction.user = context.user;
			} else nats_transaction = immediateNATSTransaction;
		}
		return nats_transaction;
	}
}

/**
 * Handles reconnection, and requesting catch-up
 */
class NodeSubscriptionConnection {
	socket: WebSocket;
	startTime: number;
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
		this.socket.on('open', () => {
			console.log('connected to ' + this.url);
			replicateOverWS(this.socket, { database: this.databaseName, subscription: this.subscription, url: this.url });
		});
		this.socket.on('error', (error) => {
			console.log('Error in connection to ' + this.url, error);
		});

		this.socket.on('close', () => {
			console.log('disconnected from ' + this.url);
			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, 200).unref();
		});
	}
	send(message) {}
}
