import { databases, onNewTable } from '../../resources/tableLoader';
import { Resource } from '../../resources/Resource';
import { publishToStream } from './utility/natsUtils';
import { SUBJECT_PREFIXES } from './utility/natsTerms';

export async function start({ server, port }) {
	for (const db_name in databases) {
		const tables = databases[db_name];
		for (const table_name in tables) {
			const table = tables[table_name];
			if (!table.Source) table.Source = getNATSReplicator(table_name, table.databasePath);
		}
	}
	onNewTable((table) => {
		if (!table.Source) table.Source = getNATSReplicator(table.tableName, table.databasePath);
	});
}

function getNATSReplicator(table_name, db_path) {
	return class NATSReplicator extends Resource {
		put(record, options) {
			let nats_transaction = this.transaction.nats;
			if (!nats_transaction)
				this.transaction.push(
					(nats_transaction = this.transaction.nats = new NATSTransaction(this.transaction, options))
				);
			// add this to the transaction
			nats_transaction.addWrite(db_path, {
				operation: 'put',
				table: table_name,
				record,
				meta: options.meta,
			});
		}
		delete(options) {
			nats_transaction.addWrite(db_path, {
				operation: 'delete',
				table: table_name,
				id: this.id,
				meta: options.meta,
			});
		}
		publish() {}
	};
}

/**
 * Holds the set of writes that will be published as a transaction message across a NATS cluster
 */
class NATSTransaction {
	writes_by_path = new Map(); // TODO: short circuit of setting up a map if all the db paths are the same (99.9% of the time that will be the case)
	constructor(protected transaction) {}
	addWrite(database_path, write) {
		let writes_for_path = this.writes_by_path.get(database_path);
		if (!writes_for_path) this.writes_by_path.set(database_path, (writes_for_path = []));
		writes_for_path.push(write);
	}
	commit(flush) {
		const promises = [];
		for (const [db_path, writes] of this.writes_by_path) {
			if (db_path.includes('/')) {
				// legacy path
				for (const write of writes) {
					const schema = db_path.split('/')[0];
					promises.push(
						publishToStream(
							`${SUBJECT_PREFIXES.TXN}.${db_path}`,
							crypto_hash.createNatsTableStreamName(schema, write.table),
							write.meta, //nats_msg_header,
							{
								operation: write.operation == 'put' ? 'upsert' : write.operation,
								schema: db_path.split('/')[0],
								table: write.table,
								__origin: {},
							}
						)
					);
				}
			} else {
				promises.push(
					publishToStream(
						`${SUBJECT_PREFIXES.TXN}.${db_path}`,
						db_path, //crypto_hash.createNatsTableStreamName(request_body.schema, request_body.table),
						writes.meta, //nats_msg_header,
						{
							txnTime: this.transaction._txnTime,
							writes,
						}
					)
				);
			}
		}
		return Promise.all(promises);
	}
}
