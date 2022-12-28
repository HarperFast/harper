import hdb_terms from '../utility/hdbTerms';
import common from '../utility/lmdb/commonUtility';
import { Resource } from './Resource';
import {}

const INVALIDATED = 1;


class Table implements Resource {
	constructor(lmdb_db, options) {
		this.primaryStore = open(options.schema, options.table);
		this.indices = [];
		this.primaryKey = 'id';
		this.lmdb_db = lmdb_db;
	}
	primaryKey: string
	get(key, options) {
		// TODO: determine if we use lazy access properties
		let entry = this.primaryStore.getEntry(key);
		let record = entry?.value;
		if (record) {
			let availability = record.__availability__;
			if (availability?.cached & INVALIDATED) {
				if (availability.residence) {
					// TODO: Implement retrieval from other nodes once we have horizontal caching

				}
				// TODO: retrieve it
				if (this.Source) {
					let previousUpdated = record.__updated__;
					this.markAsResolving();
					let source = new this.Source();
					let updated_record = source.get(key, options);
					let updated = source.lastAccessTime;
					if (updated) {
						updated_record.__updated__ = updated;
					}
					updated_record.__availability__ = { residence: [here], cached: true };
					updated_record[this.primaryKey] = key;
					this.put(record, { ifVersion: updated });
				}
			}
		}
	}
	put(record, options) {
		let id = record[this.primaryKey];
		if (!id) {
			id = record[this.primaryKey] = uuid.v4();
		}
		let primary_dbi = env.dbis[hash_attribute];
		let existing_entry = this.primaryStore.getEntry(id);
		let existing_record = existing_entry?.value;
		let had_existing = existing_record;
		if (!existing_record) {
			if (must_exist) return false;
			existing_record = {};
		}
		setTimestamps(record, !had_existing, generate_timestamps);
		if (
			Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME]) &&
			existing_record[UPDATED_TIME_ATTRIBUTE_NAME] > record[UPDATED_TIME_ATTRIBUTE_NAME]
		) {
			// This is not an error condition in our world of last-record-wins
			// replication. If the existing record is newer than it just means the provided record
			// is, well... older. And newer records are supposed to "win" over older records, and that
			// is normal, non-error behavior.
			return false;
		}
		if (had_existing) result.original_records.push(existing_record);
		let completion;
		const do_put = () => {
			// iterate the entries from the record
			// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it is
			// inside a write transaction
			for (let i = 0, l = this.indices.length; i < l; i++) {
				let index = this.indices[i];
				let value = record[key];
				let existing_value = existing_record[key];
				if (value === existing_value) {
					continue;
				}

				//if the update cleared out the attribute value we need to delete it from the index
				let values = common.getIndexedValues(existing_value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({key: v, value: hash_value})),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						index.remove(values[i], hash_value);
					}
				}
				values = common.getIndexedValues(value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({key: v, value: hash_value})),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						index.put(values[i], hash_value);
					}
				}
			}

		}
		// use optimistic locking to only commit if the existing record state still holds true.
		// this is superior to using an async transaction since it doesn't require JS execution
		// during the write transaction.
		if (existing_entry) completion = primary_dbi.ifVersion(hash_value, existing_entry.version, do_put);
		else completion = primary_dbi.ifNoExists(hash_value, do_put);
		return completion.then((success) => {
			if (!success) {
				// try again
				return this.put(record, options);
			}
			return true;
		});
	}
	delete(key, options) {

	}
	search(query, options) {

	}
	subscribe(query, options) {

	}
	sourcedFrom(Resource) {
		// define a source for retrieving invalidated entries for caching purposes
		this.Source = Resource;
	}
}
module.exports = { Table };
function findTables() {

}
function syncSchemaMetadata() {
	let table_table = global.hdb_table || (global.hdb_table = open());
	for (let { table, schema } of table_table.search()) {
		let schema_object = schema === 'default' ? global : global[schema];
		let table_object = schema_object[table] || schema_object[table] = open();

	}
}
