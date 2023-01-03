import hdb_terms from '../utility/hdbTerms';
import { open, Database } from 'lmdb';
import common from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { randomUUID } from 'crypto';
import { Resource } from './Resource';
import { Transaction } from './Transaction';
const lmdb_terms = require('../../../../utility/lmdb/terms');
const RANGE_ESTIMATE = 100000000;
const LAZY_PROPERTY_ACCESS = { lazy: true };

const INVALIDATED = 1;

export class Table {
	primaryDbi: Database
	indices: Database[]
	envPath: string
	attributes: {}[]
	primaryKey: string
	Source: { new(): Resource }
	Transaction: { new(settings): Transaction, Source: { new(): Resource } }

	constructor(primaryDbi, options) {
		this.primaryDbi = primaryDbi;
		this.indices = [];
		this.primaryKey = 'id';
		this.envPath = primaryDbi.env.path;
		this.Transaction = makeTransactionClass(this);
	}
	sourcedFrom(Resource) {
		// define a source for retrieving invalidated entries for caching purposes
		this.Source = Resource;
		this.Transaction.Source = Resource;
	}

	transaction(envTransaction) {
		return new this.Transaction(envTransaction);
	}
}
function makeTransactionClass({ primaryKey: primary_key, indices, attributes, primaryDbi: primary_dbi }: {
		primaryDbi: Database
		indices: Database[],
		attributes: {}[],
		primaryKey: string }) {
	return class TableTransaction extends Transaction {
		table: any
 		envTxn: Transaction
		lmdbTxn: any
		lastAccessTime: number = 0
		static Source: { new(): Resource }

		constructor(env_txn, settings) {
			super(settings, false);
			this.envTxn = env_txn;
			if (settings.readOnly)
				this.lmdbTxn = primary_dbi.useReadTransaction();

		}
		updateAccessTime(latest) {
			if (latest > this.lastAccessTime) {
				this.lastAccessTime = latest;
				if (this.parent.updateAccessTime)
					this.parent.updateAccessTime(latest);
			}
		}
		async get(key) {
			// TODO: determine if we use lazy access properties
			let env_txn = this.envTxn;
			let entry = primary_dbi.getEntry(key, { transaction: env_txn.getReadTxn() });
			if (env_txn.fullIsolation) {
				env_txn.recordRead(primary_dbi, key, entry.version);
			}
			if (entry.version > this.lastAccessTime) {
				this.updateAccessTime(entry.version);
			}

			let record = entry?.value;
			if (record) {
				let availability = record.__availability__;
				if (availability?.cached & INVALIDATED) {
					// TODO: If cold storage/alternate storage is available, retrieve from there

					if (availability.residence) {
						// TODO: Implement retrieval from other nodes once we have horizontal caching

					}
					// TODO: retrieve it
					if (TableTransaction.Source) {
						let previousUpdated = record.__updated__;
						this.markAsResolving();
						let source = new TableTransaction.Source();
						let updated_record = source.get(key, options);
						let updated = source.lastAccessTime;
						if (updated) {
							updated_record.__updated__ = updated;
						}
						updated_record.__availability__ = {residence: [/*here*/], cached: true};
						updated_record[this.primaryKey] = key;
						this.put(record, {ifVersion: updated});
					}
				}
			}
		}

		markAsResolving() {
		}

		put(record, options): Promise<any> {
			let env_txn = this.envTxn;
			let id = record[primary_key];
			if (!id) {
				id = record[primary_key] = randomUUID();//uuid.v4();
			}
			let existing_entry = primary_dbi.getEntry(id);
			let existing_record = existing_entry?.value;
			let had_existing = existing_record;
			if (!existing_record) {
				existing_record = {};
			}
			if (attributes && !options?.noValidation) {
				let validation_errors;
				for (let i = 0, l = attributes.length; i < l; i++) {
					let attribute = attributes[i];
					if (attribute.type === typeof record[attribute.name]) {
						// any other validations
					} else if (attribute.required && record[attribute.name] == null) {
						(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} is required`);
					} else {
						(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} must be a ${attribute.type}`);
					}
				}
				if (validation_errors) {
					throw new Error(validation_errors.join('. '));
				}
			}
			let batch = this.primaryBatch || (this.primaryBatch = primary_dbi.batch());

			//setTimestamps(record, !had_existing, generate_timestamps);
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

			let writes = [];
			// iterate the entries from the record
			// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
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
							values.map((v) => ({key: v, value: id})),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						writes.push({ db: index, operations: 'remove', key: values[i], value: id });
					}
				}
				values = common.getIndexedValues(value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({key: v, value: id})),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						writes.push({ db: index, operations: 'put', key: values[i], value: id });
					}
				}
			}

			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			// during the write transaction.
			env_txn.operations.push({
				ifId: id,
				ifVersion: existing_entry ? existing_entry.version : null,
				writes,
			});

			return Promise.resolve();
		}

		delete(key, options): Promise<any> {
			return Promise.resolve();
		}

		search(query, options): AsyncIterable<any> {
			query.offset = Number.isInteger(query.offset) ? query.offset : 0;

			// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
			// it allows us to do minimal filtering, and for union where we can return the fastest results first
			// in an iterator/stream.
			let sorted_conditions = sortBy(query.conditions, (condition) => {
				if (condition.estimated_count === undefined) {
					// skip if it is cached
					let search_type = condition.search_type;
					if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS) {
						// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
						let index = indices[condition.search_attribute];
						condition.estimated_count = index ? index.getValuesCount(condition.search_value) : Infinity;
					} else if (search_type === lmdb_terms.SEARCH_TYPES.CONTAINS || search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH)
						condition.estimated_count = Infinity;
						// this search types can't/doesn't use indices, so try do them last
					// for range queries (betweens, starts-with, greater, etc.), just arbitrarily guess
					else condition.estimated_count = RANGE_ESTIMATE;
				}
				return condition.estimated_count; // use cached count
			});
			// both AND and OR start by getting an iterator for the ids for first condition
			let ids = await executeConditionSearch(transaction, query, sorted_conditions[0], table_info.hash_attribute);
			// and then things diverge...
			let records;
			if (!query.operator || query.operator.toLowerCase() === 'and') {
				// get the intersection of condition searches by using the indexed query for the first condition
				// and then filtering by all subsequent conditions
				let primary_dbi = env.dbis[table_info.hash_attribute];
				let filters = sorted_conditions.slice(1).map(lmdb_search.filterByType);
				let filters_length = filters.length;
				let fetch_attributes = search_utility.setGetWholeRowAttributes(env, query.get_attributes);
				records = ids.map((id) => primary_dbi.get(id, { transaction, lazy: true }));
				if (filters_length > 0)
					records = records.filter((record) => {
						for (let i = 0; i < filters_length; i++) {
							if (!filters[i](record)) return false; // didn't match filters
						}
						return true;
					});
				if (query.offset || query.limit !== undefined)
					records = records.slice(
						query.offset,
						query.limit !== undefined ? (query.offset || 0) + query.limit : undefined
					);
				records = records.map((record) => cursor_functions.parseRow(record, fetch_attributes));
			} else {
				//get the union of ids from all condition searches
				for (let i = 1; i < sorted_conditions.length; i++) {
					let condition = sorted_conditions[i];
					// might want to lazily execute this after getting to this point in the iteration
					let next_ids = await executeConditionSearch(transaction, query, condition, table_info.hash_attribute);
					ids = ids.concat(next_ids);
				}
				let returned_ids = new Set();
				let offset = query.offset || 0;
				ids = ids
					.filter((id) => {
						if (returned_ids.has(id))
							// skip duplicates
							return false;
						returned_ids.add(id);
						return true;
					})
					.slice(offset, query.limit && query.limit + offset);
				records = search_utility.batchSearchByHash(transaction, table_info.hash_attribute, query.get_attributes, ids);
			}
			records.onDone = () => {
				transaction.done();// need to complete the transaction once iteration is complete
			};
			return records;
		}

		subscribe(query, options) {
			return {};
		}

	}
}