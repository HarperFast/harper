import { getDatabases, onUpdatedTable } from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { publishToStream as natsPublishToStream } from './utility/natsUtils';
import { SUBJECT_PREFIXES } from './utility/natsTerms';
import { createNatsTableStreamName } from '../../security/cryptoHash';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { setSubscription as natsSetSubscription } from './natsIngestService';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility';
import env from '../../utility/environment/environmentManager';
import hdb_terms from '../../utility/hdbTerms';
import * as harper_logger from '../../utility/logging/harper_logger';
import { Context } from '../../resources/ResourceInterface';

let nats_disabled;
export function start() {
	if (env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		assignReplicationSource();
	}
}
export function disableNATS(disabled = true) {
	nats_disabled = disabled;
}
export let publishToStream = natsPublishToStream;
export let setSubscription = natsSetSubscription;
export function setPublishToStream(new_publish, new_setSubscription) {
	publishToStream = new_publish;
	setSubscription = new_setSubscription;
}
const MAX_INGEST_THREADS = 2;
let immediateNATSTransaction, subscribed_to_nodes;
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource() {
	if (nats_disabled || process.env._DISABLE_NATS) return;
	const databases = getDatabases();
	const database_names = Object.keys(databases);
	database_names.push('system');
	for (const database_name of database_names) {
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
}
const NEVER_REPLICATE_SYSTEM_TABLES = ['hdb_job', 'hdb_analytics', 'hdb_raw_analytics', 'hdb_info', 'hdb_license'];
/*
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
	if (db_name === 'system' && NEVER_REPLICATE_SYSTEM_TABLES.includes(table_name)) return;
	if (!Table) {
		return console.error(`Attempt to replicate non-existent table ${table_name} from database ${db_name}`);
	}
	if (Table.sources.some((source) => source?.isNATSReplicator)) return;
	Table.sourcedFrom(
		class NATSReplicator extends Resource {
			put(record) {
				// add this to the transaction
				return getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'put',
					table: table_name,
					id: this[ID_PROPERTY],
					record,
				});
			}
			delete() {
				return getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'delete',
					table: table_name,
					id: this[ID_PROPERTY],
				});
			}
			publish(message) {
				return getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'publish',
					table: table_name,
					id: this[ID_PROPERTY],
					record: message,
				});
			}
			patch(update) {
				return getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'patch',
					table: table_name,
					id: this[ID_PROPERTY],
					record: update,
				});
			}
			invalidate() {
				getNATSTransaction(this.getContext()).addWrite(db_name, {
					operation: 'invalidate',
					table: table_name,
					id: this[ID_PROPERTY],
				});
			}
			static defineSchema(Table) {
				publishSchema(Table);
			}

			/**
			 * This subscribes to the NATS ingest service so that incoming NATS messages are delivered
			 * to tables as subscription events. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static subscribe() {
				const subscription = new IterableEventQueue();
				setSubscription(db_name, table_name, subscription);
				return subscription;
			}
			static subscribeOnThisThread(worker_index) {
				return (
					worker_index <
					(env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXINGESTTHREADS) ?? MAX_INGEST_THREADS)
				);
			}
			static isEqual(source) {
				return source.isNATSReplicator;
			}

			static isNATSReplicator = true;
			static shouldReceiveInvalidations = true;
		},
		{ intermediateSource: true }
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
				context.transaction.nats = nats_transaction = new NATSTransaction(context.transaction, context);
				let last_transaction = context.transaction;
				while (last_transaction.next) last_transaction = last_transaction.next;
				last_transaction.next = context.transaction.nats;
				nats_transaction.user = context.user;
				nats_transaction.context = context;
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
	addWrite(database_path, write) {
		write.expiresAt = this.context?.expiresAt;
		let writes_for_path = this.writes_by_db.get(database_path);
		if (!writes_for_path) this.writes_by_db.set(database_path, (writes_for_path = []));
		writes_for_path.push(write);
	}

	/**
	 * Once a transaction is completed, we put all the accumulated writes into a single NATS
	 * message and publish it to the cluster
	 */
	commit({ timestamp }) {
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
							timestamp,
							node_name,
						},
					};
					transaction_event.hash_values = ids;
					if (operation !== 'delete' && operation !== 'invalidate') {
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
				if (write.expiresAt) last_write_event.expiresAt = write.expiresAt;
			}
			if (transaction_event) {
				promises.push(
					publishToStream(
						`${SUBJECT_PREFIXES.TXN}.${db}.${transaction_event.table}`,
						createNatsTableStreamName(db, transaction_event.table),
						undefined,
						transaction_event
					)?.catch((error) => {
						harper_logger.error('An error has occurred trying to replicate transaction', transaction_event, error);
						error.statusCode = 504; // Gateway timeout is the best description of this type of failure
						throw error;
					})
				);
			}
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
		this.commit({});
	}
}
immediateNATSTransaction = new ImmmediateNATSTransaction();
