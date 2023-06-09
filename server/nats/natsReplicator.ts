import { databases, getDatabases, onNewTable } from '../../resources/databases';
import { ID_PROPERTY, Resource, TRANSACTIONS_PROPERTY, USER_PROPERTY } from '../../resources/Resource';
import { publishToStream } from './utility/natsUtils';
import { SUBJECT_PREFIXES } from './utility/natsTerms';
import { createNatsTableStreamName } from '../../security/cryptoHash';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { getWorkerIndex } from '../threads/manageThreads';
import { setSubscription } from './natsIngestService';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility';
import env from '../../utility/environment/environmentManager';
import hdb_terms from '../../utility/hdbTerms';
import { onMessageFromWorkers } from '../../server/threads/manageThreads';
import { threadId } from 'worker_threads';
import initializeReplyService from './natsReplyService';

let publishing_databases = new Map();
export function start() {
	if (env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) assignReplicationSource();
}
const MAX_INGEST_THREADS = 1;
let immediateNATSTransaction, subscribed_to_nodes;
/**
 * This will assign the NATS replicator as a source to any tables that have subscriptions to them (are publishing to other nodes)
 */
function assignReplicationSource() {
	const databases = getDatabases();
	for (const database_name in databases) {
		const database = databases[database_name];
		for (const table_name in database) {
			const Table = database[table_name];
			setNATSReplicator(table_name, database_name, Table);
		}
	}
	publishing_databases = new Map();
	onNewTable((Table, is_changed) => {
		if (Table?.Source) return;
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
	if (Table.Source) return;

	Table.sourcedFrom(
		class NATSReplicator extends Resource {
			put(record, options) {
				// add this to the transaction
				this.getNATSTransaction(options).addWrite(db_name, {
					operation: 'put',
					table: table_name,
					record,
				});
			}
			delete(options) {
				this.getNATSTransaction(options).addWrite(db_name, {
					operation: 'delete',
					table: table_name,
					id: this[ID_PROPERTY],
				});
			}
			publish(message, options) {
				this.getNATSTransaction(options).addWrite(db_name, {
					operation: 'publish',
					table: table_name,
					id: this[ID_PROPERTY],
					record: message,
				});
			}
			static defineSchema(Table) {
				publishSchema(Table);
			}
			getNATSTransaction(options): NATSTransaction {
				let nats_transaction: NATSTransaction = this[TRANSACTIONS_PROPERTY]?.nats;
				if (!nats_transaction) {
					if (this[TRANSACTIONS_PROPERTY]) {
						this[TRANSACTIONS_PROPERTY].push(
							(nats_transaction = this[TRANSACTIONS_PROPERTY].nats =
								new NATSTransaction(this[TRANSACTIONS_PROPERTY], options))
						);
						nats_transaction.user = this[USER_PROPERTY];
					} else nats_transaction = immediateNATSTransaction;
				}
				return nats_transaction;
			}
			static subscribe() {
				if (getWorkerIndex() < MAX_INGEST_THREADS) {
					const subscription = new IterableEventQueue();
					setSubscription(db_name, table_name, subscription);
					return subscription;
				}
			}
		}
	);
}
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
			attributes: Table.attributes,
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
		let writes_for_path = this.writes_by_db.get(database_path);
		if (!writes_for_path) this.writes_by_db.set(database_path, (writes_for_path = []));
		writes_for_path.push(write);
	}
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
					if (operation === 'delete') transaction_event.hash_values = ids;
					else if (operation === 'publish') {
						transaction_event.hash_values = ids;
						transaction_event.records = records;
					} else {
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
