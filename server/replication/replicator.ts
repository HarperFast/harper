import { databases, table as defineTable, getDatabases, onUpdatedTable } from '../../resources/databases';
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

const SUBSCRIPTION_CODE = 129;
const SEND_TABLE_NAME = 130;
const SEND_TABLE_STRUCTURE = 131;
const SEND_TABLE_FIXED_STRUCTURE = 132;
const table_update_listeners = new Map();
let replication_disabled;
export function start(options) {
	if (!options?.manualAssignment) assignReplicationSource();
	server.ws(
		(ws, request, ready) => {
			console.log('registering', options);
			ws.on('message', (body) => {
				const action = body[0];

				const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
				const db_length = body[1];
				const database_name = body.toString('utf8', 2, db_length + 2);
				const start_time = decoder.getFloat64(2 + db_length);
				const database = (options.databases || databases)[database_name];
				console.log('receive subscription request', database_name, options);
				let first_table;
				const table_by_id = [];
				for (const key in database) {
					const table = database[key];
					first_table = first_table || table;
					table_by_id[table.tableId] = { table };
				}
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
						writeBytes(audit_record.encoded, audit_record.encoded[0] === 66 ? 8 : 0); //
						const table_entry = table_by_id[table_id];
						if (!table_entry.sentName) {
							table_entry.sentName = true;
							console.log('send table name', table_entry.table.tableName);
							ws.send(encode([SEND_TABLE_NAME, table_id, table_entry.table.tableName]));
						}
						const typed_structs = table_entry.table.primaryStore.encoder.typedStructs;
						if (typed_structs.length != table_entry.typed_length) {
							table_entry.typed_length = typed_structs.length;
							console.log('send table struct', typed_structs);
							ws.send(encode([SEND_TABLE_FIXED_STRUCTURE, table_id, typed_structs]));
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
			});
		},
		Object.assign(
			// We generally expect this to use the operations API ports (9925)
			{
				protocol: 'harperdb-replication',
			},
			options
		)
	);
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
			setReplicator(table_name, database_name, Table, options);
		}
	}
	onUpdatedTable((Table, is_changed) => {
		setReplicator(Table.tableName, Table.databaseName, Table, options);
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
export function setReplicator(table_name, db_name, Table, options) {
	if (!Table) {
		return console.error(`Attempt to replicate non-existent table ${table_name} from database ${db_name}`);
	}
	if (Table.replicated === false || Table.Source?.isNATSReplicator) return;
	let source;
	// We may try to consult this to get the other nodes for back-compat
	// const { hub_routes } = getClusteringRoutes();
	Table.sourcedFrom(
		class Replicator extends Resource {
			/**
			 * This subscribes to the other nodes. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static async subscribe() {
				const subscription = (this.subscription = new IterableEventQueue());
				for (const node of options.nodes) {
					try {
						const url = node.url;
						// TODO: Do we need to have another way to determine URL?
						// Node suscription also needs to be aware of other nodes that will be excluded from the current subscription
						const connection = new NodeSubscriptionConnection(url, subscription, Table.databaseName);
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
	constructor(public url, public localQueue, public databaseName) {}
	connect() {
		const tables = [];
		this.socket = new WebSocket(this.url, 'harperdb-replication');
		this.socket.on('open', () => {
			console.log('connected to ' + this.url);
			const subscription_message = Buffer.alloc(this.databaseName.length * 3 + 8);
			subscription_message[0] = SUBSCRIPTION_CODE; // indicate we want a subscription
			let position = (subscription_message[1] = subscription_message.write(this.databaseName, 2)) + 2;
			subscription_message.writeDoubleBE(this.startTime, position);
			position += 8;
			this.socket.send(subscription_message.subarray(0, position));
			console.log('sent subscription', this.url, this.databaseName);
		});
		this.socket.on('error', (error) => {
			console.log('Error in connection to ' + this.url, error);
		});
		const table_decoders = [];
		this.socket.on('message', (body) => {
			// The routing header should consist of:
			// transaction timestamp
			// the record-transaction key (encoded using ordered-binary):
			//   table id
			//   record id
			// predicate information? (alternately we may send stream synchronization messages)
			// routing plan id (id for the route from source node to all receiving nodes)

			const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
			const txn_time = decoder.getFloat64(0);
			console.log('received message on', this.url, 'txn time', txn_time);
			if (txn_time < 0) {
				// not a transaction, special message
				const message = decode(body);
				const [command, table_id, data] = message;
				let table_connector;
				switch (command) {
					case SEND_TABLE_NAME:
						tables[table_id] = {
							name: data,
							encoder: new Packr({ useBigIntExtension: true, randomAccessStructure: true, freezeData: true }),
						};
						break;
					case SEND_TABLE_FIXED_STRUCTURE:
						table_connector = tables[table_id];
						if (!table_connector.encoder.typedStructs) table_connector.encoder.typedStructs = [];
						table_connector.encoder.typedStructs.push(data);
						break;
				}
				return;
			}
			decoder.position = 8;
			do {
				/*const table_id = decoder.readInt();
				const key_length = decoder.readInt();
				const record_key = readKey(body, decoder.position, (decoder.position += key_length));*/
				const audit_record = readAuditEntry(body);
				this.localQueue.send(audit_record);
				// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
			} while (decoder.position < body.byteLength);
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
