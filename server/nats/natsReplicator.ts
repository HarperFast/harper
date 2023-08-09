import { getDatabases, onUpdatedTable } from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { publishToStream } from './utility/natsUtils';
import { SUBJECT_PREFIXES } from './utility/natsTerms';
import { createNatsTableStreamName } from '../../security/cryptoHash';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { getWorkerIndex } from '../threads/manageThreads';
import { setSubscription } from './natsIngestService';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility';
import env from '../../utility/environment/environmentManager';
import hdb_terms from '../../utility/hdbTerms';
import * as harper_logger from '../../utility/logging/harper_logger';
import { Context } from '../../resources/ResourceInterface';

let nats_disabled;
export function start() {
	if (env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) assignReplicationSource();
}
export function disableNATS(disabled = true) {
	nats_disabled = disabled;
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
function assignReplicationSource() {
	if (nats_disabled) return;
	const databases = getDatabases();
	for (const database_name in databases) {
		const database = databases[database_name];
		for (const table_name in database) {
			const Table = database[table_name];
			setNATSReplicator(table_name, database_name, Table);
		}
	}
	onUpdatedTable((Table, is_changed) => {
		setNATSReplicator(Table.tableName, Table.databaseName, Table);
		if (is_changed) publishSchema(Table);
	});
	if (subscribed_to_nodes) return;
	subscribed_to_nodes = true;
} /*
onMessageFromWorkers((event) => {
	if (event.type === 'nats_update') {
		assignReplicationSource();
	}
});
/**
 * Get/create a NATS replication resource that can be assigned as a source to tables
 * @param table_name
 * @param db_name
 */
export function setNATSReplicator(table_name, db_name, Table) {
	if (!Table) {
		return console.error(`Attempt to replicate non-existent table ${table_name} from database ${db_name}`);
	}
	if (Table.Source?.isNATSReplicator) return;
	let source;
	Table.sourcedFrom(
		class NATSReplicator extends Resource {
			put(record) {
				// add this to the transaction
				let completion;
				if (source?.put && (!source.put.reliesOnPrototype || source.prototype.put))
					completion = source.put(this[ID_PROPERTY], record, this.getContext());
				return getNATSTransaction(this.getContext()).addWrite(
					db_name,
					{
						operation: 'put',
						table: table_name,
						id: this[ID_PROPERTY],
						record,
					},
					completion
				);
			}
			delete() {
				let completion;
				if (source?.delete && (!source.delete.reliesOnPrototype || source.prototype.delete))
					completion = source.delete(this[ID_PROPERTY], this.getContext());
				return getNATSTransaction(this.getContext()).addWrite(
					db_name,
					{
						operation: 'delete',
						table: table_name,
						id: this[ID_PROPERTY],
					},
					completion
				);
			}
			publish(message) {
				let completion;
				if (source?.publish && (!source.publish.reliesOnPrototype || source.prototype.publish))
					completion = source.publish(this[ID_PROPERTY], message, this.getContext());
				return getNATSTransaction(this.getContext()).addWrite(
					db_name,
					{
						operation: 'publish',
						table: table_name,
						id: this[ID_PROPERTY],
						record: message,
					},
					completion
				);
			}
			invalidate(message) {
				getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'invalidate',
					table: table_name,
					id: this[ID_PROPERTY],
				});
				if (source?.invalidate && (!source.invalidate.reliesOnPrototype || source.prototype.invalidate))
					return source.invalidate(this[ID_PROPERTY], this.getContext());
			}
			static defineSchema(Table) {
				publishSchema(Table);
			}

			/**
			 * merge access to another source
			 * @param other_source
			 */
			static mergeSource(other_source, options) {
				// define the other source as our source, so we can pass through to it
				source = other_source;
				// we can just delegate directly to the other get
				if (source?.get && (!source.get.reliesOnPrototype || source.prototype.get)) {
					if (options.replicationSource) {
						// if this source is a source for replication, we need to replicate data that
						// is fulfilled from this source
						this.get = async (id, context) => {
							const result = await source.get(id, context);
							if (result) {
								getNATSTransaction(context).addWrite(db_name, {
									operation: 'put',
									table: table_name,
									id,
									record: result,
								});
							}
							return result;
						};
					} else {
						// if we are a cache of replicated data, we just pass through
						this.get = (id, context) => source.get(id, context);
					}
				}
				return this;
			}

			/**
			 * This subscribes to the NATS ingest service so that incoming NATS messages are delivered
			 * to tables as subscription events. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static subscribe() {
				if (getWorkerIndex() < MAX_INGEST_THREADS) {
					const subscription = new IterableEventQueue();
					setSubscription(db_name, table_name, subscription);
					return subscription;
				}
			}
			static isNATSReplicator = true;
		}
	);
	/**
	 * This gets the NATS transaction object for the current overall transaction. This will
	 * accumulate any writes that occur during a transaction, and allow them to be aggregated
	 * into a replication message that encompasses all the writes of a transaction.
	 * @param context
	 */
	function getNATSTransaction(context: Context): NATSTransaction {
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
 * Publish/replicate an updated schema for this table, to the cluster.
 * @param Table
 */
function publishSchema(Table) {
	const node_name = env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);
	publishToStream(
		`${SUBJECT_PREFIXES.TXN}.${Table.databaseName}.${Table.tableName}`,
		createNatsTableStreamName(Table.databaseName, Table.tableName),
		undefined,
		{
			operation: 'define_schema',
			schema: Table.databaseName,
			table: Table.tableName,
			attributes: Table.attributes, // TODO: Probably be best to only propagate attribute's with indexing if the it has an operation origin
			__origin: {
				timestamp: Date.now(),
				node_name,
			},
		}
	);
}
/**
 * Holds the set of writes that will be published as a transaction message across a NATS cluster
 */
class NATSTransaction {
	user: string;
	writes_by_db = new Map(); // TODO: short circuit of setting up a map if all the db paths are the same (99.9% of the time that will be the case)
	constructor(protected transaction, protected options?) {}
	addWrite(database_path, write, completion?) {
		let writes_for_path = this.writes_by_db.get(database_path);
		if (!writes_for_path) this.writes_by_db.set(database_path, (writes_for_path = []));
		if (completion?.then) return completion.then(() => writes_for_path.push(write));
		else writes_for_path.push(write);
	}

	/**
	 * Once a transaction is completed, we put all the accumulated writes into a single NATS
	 * message and publish it to the cluster
	 */
	commit() {
		const node_name = env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);
		const promises = [];
		for (const [db, writes] of this.writes_by_db) {
			const records = [];
			const ids = [];
			let transaction_event;
			let last_write_event;
			for (const write of writes) {
				const table = write.table;
				const operation = write.operation == 'put' ? 'upsert' : write.operation;
				if (!transaction_event) {
					harper_logger.trace(`Sending transaction event ${operation}`);
					last_write_event = transaction_event = {
						operation,
						schema: db,
						table,
						__origin: {
							user: this.user?.username,
							timestamp: this.transaction.timestamp,
							node_name,
						},
					};
					transaction_event.hash_values = ids;
					if (operation !== 'delete') {
						transaction_event.records = records;
					}
				}
				if (transaction_event.table === table && transaction_event.operation === operation) {
					records.push(write.record);
					ids.push(write.id);
				} else {
					last_write_event = last_write_event.next = {
						operation,
						table,
						id: write.id,
						record: write.record,
					};
				}
			}
			promises.push(
				publishToStream(
					`${SUBJECT_PREFIXES.TXN}.${db}.${transaction_event.table}`,
					createNatsTableStreamName(db, transaction_event.table),
					undefined,
					transaction_event
				)
			);
		}
		return Promise.all(promises);
	}
}

/**
 * This is used in situations where there is no overarching transaction and we just need to immediately
 * publish the write as a message (no future commit to wait for)
 */
class ImmmediateNATSTransaction extends NATSTransaction {
	constructor() {
		super({
			get timestamp() {
				return getNextMonotonicTime();
			},
		});
	}

	addWrite(database_path, write) {
		super.addWrite(database_path, write);
		this.commit();
	}
}
immediateNATSTransaction = new ImmmediateNATSTransaction();
