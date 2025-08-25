import { getDatabases, onUpdatedTable } from '../../resources/databases.ts';
import { Resource } from '../../resources/Resource.ts';
import { publishToStream as natsPublishToStream } from './utility/natsUtils.js';
import { SUBJECT_PREFIXES } from './utility/natsTerms.js';
import { createNatsTableStreamName } from '../../security/cryptoHash.js';
import { IterableEventQueue } from '../../resources/IterableEventQueue.ts';
import { setSubscription as natsSetSubscription } from './natsIngestService.js';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility.js';
import env from '../../utility/environment/environmentManager.js';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.js';
import type { Context } from '../../resources/ResourceInterface.ts';

let natsDisabled;
export function start() {
	if (env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		assignReplicationSource();
	}
}
export function disableNATS(disabled = true) {
	natsDisabled = disabled;
}
export let publishToStream = natsPublishToStream;
export let setSubscription = natsSetSubscription;
export function setPublishToStream(newPublish, newSetSubscription) {
	publishToStream = newPublish;
	setSubscription = newSetSubscription;
}
const MAX_INGEST_THREADS = 2;
let immediateNATSTransaction, subscribedToNodes;
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource() {
	if (natsDisabled || process.env._DISABLE_NATS) return;
	const databases = getDatabases();
	const databaseNames = Object.keys(databases);
	databaseNames.push('system');
	for (const databaseName of databaseNames) {
		const database = databases[databaseName];
		for (const tableName in database) {
			const Table = database[tableName];
			setNATSReplicator(tableName, databaseName, Table);
		}
	}
	onUpdatedTable((Table, isChanged) => {
		setNATSReplicator(Table.tableName, Table.databaseName, Table);
		if (isChanged) publishSchema(Table);
	});
	if (subscribedToNodes) return;
	subscribedToNodes = true;
}
const NEVER_REPLICATE_SYSTEM_TABLES = ['hdb_job', 'hdb_raw_analytics', 'hdb_info', 'hdb_license'];
/*
onMessageFromWorkers((event) => {
	if (event.type === 'nats_update') {
		assignReplicationSource();
	}
});
/**
 * Get/create a NATS replication resource that can be assigned as a source to tables
 * @param tableName
 * @param dbName
 */
export function setNATSReplicator(tableName, dbName, Table) {
	if (dbName === 'system' && NEVER_REPLICATE_SYSTEM_TABLES.includes(tableName)) return;
	if (!Table) {
		return console.error(`Attempt to replicate non-existent table ${tableName} from database ${dbName}`);
	}
	if (Table.sources.some((source) => source?.isNATSReplicator)) return;
	Table.sourcedFrom(
		class NATSReplicator extends Resource {
			put(record) {
				// add this to the transaction
				return getNATSTransaction(this.getContext()).addWrite(dbName, {
					operation: 'put',
					table: tableName,
					id: this.getId(),
					record,
				});
			}
			delete() {
				return getNATSTransaction(this.getContext()).addWrite(dbName, {
					operation: 'delete',
					table: tableName,
					id: this.getId(),
				});
			}
			publish(message) {
				return getNATSTransaction(this.getContext()).addWrite(dbName, {
					operation: 'publish',
					table: tableName,
					id: this.getId(),
					record: message,
				});
			}
			patch(update) {
				return getNATSTransaction(this.getContext()).addWrite(dbName, {
					operation: 'patch',
					table: tableName,
					id: this.getId(),
					record: update,
				});
			}
			invalidate() {
				getNATSTransaction(this.getContext()).addWrite(dbName, {
					operation: 'invalidate',
					table: tableName,
					id: this.getId(),
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
				setSubscription(dbName, tableName, subscription);
				return subscription;
			}
			static subscribeOnThisThread(workerIndex) {
				return (
					workerIndex <
					(env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXINGESTTHREADS) ?? MAX_INGEST_THREADS)
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
		let natsTransaction: NATSTransaction = context?.transaction?.nats;
		if (!natsTransaction) {
			if (context?.transaction) {
				context.transaction.nats = natsTransaction = new NATSTransaction(context.transaction, context);
				let lastTransaction = context.transaction;
				while (lastTransaction.next) lastTransaction = lastTransaction.next;
				lastTransaction.next = context.transaction.nats;
				natsTransaction.user = context.user;
				natsTransaction.context = context;
			} else natsTransaction = immediateNATSTransaction;
		}
		return natsTransaction;
	}
}

/**
 * Publish/replicate an updated schema for this table, to the cluster.
 * @param Table
 */
function publishSchema(Table) {
	const node_name = env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);
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
	writesByDb = new Map(); // TODO: short circuit of setting up a map if all the db paths are the same (99.9% of the time that will be the case)
	constructor(
		protected transaction,
		protected options?
	) {}
	addWrite(databasePath, write) {
		write.expiresAt = this.context?.expiresAt;
		let writesForPath = this.writesByDb.get(databasePath);
		if (!writesForPath) this.writesByDb.set(databasePath, (writesForPath = []));
		writesForPath.push(write);
	}

	/**
	 * Once a transaction is completed, we put all the accumulated writes into a single NATS
	 * message and publish it to the cluster
	 */
	commit({ timestamp }) {
		const node_name = env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);
		const promises = [];
		for (const [db, writes] of this.writesByDb) {
			const records = [];
			const ids = [];
			let transactionEvent;
			let lastWriteEvent;
			for (const write of writes) {
				const table = write.table;
				const operation = write.operation == 'put' ? 'upsert' : write.operation;
				if (!transactionEvent) {
					harperLogger.trace(`Sending transaction event ${operation}`);
					lastWriteEvent = transactionEvent = {
						operation,
						schema: db,
						table,
						__origin: {
							user: this.user?.username,
							timestamp,
							node_name,
						},
					};
					transactionEvent.hash_values = ids;
					if (operation !== 'delete' && operation !== 'invalidate') {
						transactionEvent.records = records;
					}
				}
				if (transactionEvent.table === table && transactionEvent.operation === operation) {
					records.push(write.record);
					ids.push(write.id);
				} else {
					lastWriteEvent = lastWriteEvent.next = {
						operation,
						table,
						id: write.id,
						record: write.record,
					};
				}
				if (write.expiresAt) lastWriteEvent.expiresAt = write.expiresAt;
			}
			if (transactionEvent) {
				promises.push(
					publishToStream(
						`${SUBJECT_PREFIXES.TXN}.${db}.${transactionEvent.table}`,
						createNatsTableStreamName(db, transactionEvent.table),
						undefined,
						transactionEvent
					)?.catch((error) => {
						harperLogger.error('An error has occurred trying to replicate transaction', transactionEvent, error);
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

	addWrite(databasePath, write) {
		super.addWrite(databasePath, write);
		this.commit({});
	}
}
immediateNATSTransaction = new ImmmediateNATSTransaction();
