import { databases, getDatabases, onNewTable } from '../../resources/databases';
import { Resource } from '../../resources/Resource';
import { publishToStream } from './utility/natsUtils';
import { SUBJECT_PREFIXES } from './utility/natsTerms';
import { createNatsTableStreamName } from '../../security/cryptoHash';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { getWorkerIndex } from '../threads/manageThreads';
import { setSubscription } from './natsIngestService';

let publishing_databases = new Map();
export async function start() {
	await assignReplicationSource();
}
const MAX_INGEST_THREADS = 2;

/**
 * This will assign the NATS replicator as a source to any tables that have subscriptions to them (are publishing to other nodes)
 */
async function assignReplicationSource() {
	publishing_databases = new Map();
	const hdb_nodes = getDatabases().system.hdb_nodes;
	for await (const node of await hdb_nodes.search([])) {
		const { subscriptions } = node;
		for (const subscription of subscriptions) {
			if (!subscription.publish) continue;
			const db = subscription.schema;
			let publishing = publishing_databases.get(db);
			if (!publishing) publishing_databases.set(db, (publishing = new Map()));
			if (subscription.table) publishing.set(subscription.table, true);
			else publishing.publishingDatabase = true;
		}
	}
	console.log({ publishing_databases });
	for (const [db_name, publishing] of publishing_databases) {
		const tables = databases[db_name];
		if (!tables) {
			// TODO: Do we auto-create the table?
			console.log(`database ${db_name} not found for replication`);
			continue;
		}
		if (publishing.publishingDatabase) {
			// if we are publishing the full database, assign as source of all the tables in the database
			for (const table_name in tables) {
				const table = tables[table_name];
				setNATSReplicator(table_name, db_name, table);
			}
		} else {
			// otherwise just assign as source of tables that are actually publishing
			for (const [table_name] of publishing) {
				const table = tables[table_name];
				setNATSReplicator(table_name, db_name, table);
			}
		}
	}
	onNewTable((table) => {
		setNATSReplicator(table.tableName, table.databasePath, table);
	});
	databases.system.hdb_nodes.subscribe({
		listener() {
			assignReplicationSource();
		},
	});
}

/**
 * Get/create a NATS replication resource that can be assigned as a source to tables
 * @param table_name
 * @param db_name
 */
export function setNATSReplicator(table_name, db_name, Table) {
	if (Table.Source) return;
	publishToStream(
		`${SUBJECT_PREFIXES.TXN}.${db_name}`,
		createNatsTableStreamName(db_name, table_name),
		Table.origin?.nats_msg_header,
		{
			operation: 'define_table',
			table: Table.tableName,
			attributes: Table.attributes,
		}
	);

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
					id: this.id,
				});
			}
			publish(message, options) {
				this.getNATSTransaction(options).addWrite(db_name, {
					operation: 'publish',
					table: table_name,
					record: message,
				});
			}
			getNATSTransaction(options): NATSTransaction {
				let nats_transaction: NATSTransaction = this.transactions.nats;
				if (!nats_transaction) {
					this.transactions.push(
						(nats_transaction = this.transactions.nats = new NATSTransaction(this.transactions, options))
					);
					nats_transaction.user = this.user;
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

/**
 * Holds the set of writes that will be published as a transaction message across a NATS cluster
 */
class NATSTransaction {
	user: string;
	writes_by_db = new Map(); // TODO: short circuit of setting up a map if all the db paths are the same (99.9% of the time that will be the case)
	constructor(protected transaction, protected options) {}
	addWrite(database_path, write) {
		let writes_for_path = this.writes_by_db.get(database_path);
		if (!writes_for_path) this.writes_by_db.set(database_path, (writes_for_path = []));
		writes_for_path.push(write);
	}
	commit() {
		const promises = [];
		for (const [db, writes] of this.writes_by_db) {
			const publishing = publishing_databases.get(db);
			if (!publishing) continue;
			if (publishing.publishingDatabase) {
				promises.push(
					publishToStream(
						`${SUBJECT_PREFIXES.TXN}.${db}`,
						db, // Do we need createNatsTableStreamName for just a database name?
						this.options?.nats_msg_header,
						{
							timestamp: this.transaction.timestamp,
							user: this.user,
							writes,
						}
					)
				);
			}
			if (publishing.size > 0) {
				const records_by_table = new Map();
				for (const write of writes) {
					const table = write.table;
					if (publishing.has(table)) {
						let records = records_by_table.get(table);
						if (!records) {
							records_by_table.set(table, (records = []));
							records.operation = write.operation;
						}
						records.push(write.record || write.id);
					}
				}
				for (const [table, records] of records_by_table) {
					publishToStream(
						`${SUBJECT_PREFIXES.TXN}.${db}`,
						createNatsTableStreamName(db, table),
						this.options?.nats_msg_header,
						{
							operation: records.operation == 'put' ? 'upsert' : records.operation,
							schema: db,
							table,
							records,
							__origin: {
								user: this.user,
								timestamp: this.transaction.timestamp,
							},
						}
					);
				}
			}
		}
		return Promise.all(promises);
	}
}
