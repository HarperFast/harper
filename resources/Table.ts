import { CONFIG_PARAMS, TIME_STAMP_NAMES_ENUM } from '../utility/hdbTerms';
import { open, Database } from 'lmdb';
import common from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { randomUUID } from 'crypto';
import { ResourceInterface } from './ResourceInterface';
import { workerData } from 'worker_threads';
import { EnvTransaction, Resource } from './Resource';
import { compareKeys } from 'ordered-binary';
import { onMessageFromWorkers, broadcast } from '../server/threads/manage-threads';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';

const TRANSACTION_EVENT_TYPE = 'transaction';
const RANGE_ESTIMATE = 100000000;
env_mngr.initSync();
let b = Buffer.alloc(1);
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const CREATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const LAZY_PROPERTY_ACCESS = { lazy: true };
const TXN_KEY = Symbol('transaction');

const INVALIDATED = 16;

export class Table {
	primaryDbi: Database
	indices: Database[]
	envPath: string
	tableName: string
	schemaName: string
	attributes: any[]
	primaryKey: string
	subscriptions: Map<any, Function[]>
	expirationTimer: ReturnType<typeof setInterval>
	expirationMS: number
	Source: { new(): ResourceInterface }
	Transaction: ReturnType<typeof makeTransactionClass>

	constructor(primaryDbi, options) {
		this.primaryDbi = primaryDbi;
		this.indices = [];
		this.primaryKey = 'id';
		this.envPath = primaryDbi.env.path;
		primaryDbi.encoder.structConstructor = createRecordClass();
		this.tableName = options.tableName;
		this.Transaction = makeTransactionClass(this);
		primaryDbi.on('aftercommit', ({next, last}) => {
			// after each commit, broadcast the transaction to all threads so subscribers can read the
			// transactions and find changes of interest. We try to use the same binary format for
			// transactions that is used by lmdb-js for minimal modification and since the binary
			// format can readily be shared with other threads
			let transaction_buffers = [];
			let last_uint32;
			let start;
			// get all the buffers (and starting position of the first) in this transaction
			do {
				if (next.uint32 !== last_uint32) {
					last_uint32 = next.uint32;
					if (last_uint32) {
						if (start === undefined)
							start = next.flagPosition;
						transaction_buffers.push(last_uint32.buffer);
					}
				}
				next = next.next;
			} while (next !== last);
			// broadcast all the transaction buffers so they can be (sequentially) read
			broadcast({
				type: TRANSACTION_EVENT_TYPE,
				start,
				buffers: transaction_buffers,
			});
		});
	}
	sourcedFrom(Resource) {
		// define a source for retrieving invalidated entries for caching purposes
		this.Source = Resource;
		this.Transaction.Source = Resource;
	}
	/**
	 * Set TTL expiration for records in this table
	 * @param expiration_time Time in seconds
	 */
	setTTLExpiration(expiration_time) {
		// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
		// so we use the first one
		if (workerData.isFirst) {
			if (!this.expirationTimer) {
				let expiration_ms = expiration_time * 1000;
				this.expirationMS = expiration_ms; // in JS we use milliseconds
				this.expirationTimer = setInterval(() => {
					// iterate through all entries to find expired ones
					for (let { key, value: record, version } of this.primaryDbi.getRange({ start: false, versions: true })) {
						if (version < Date.now() - expiration_ms) {
							// make sure we only delete it if the version has not changed
							this.primaryDbi.ifVersion(key, version, () => this.primaryDbi.remove(key));
						}
					}
				}, expiration_ms);
			}
		}
	}

	/**
	 * Make a subscription to a query, to get notified of any changes to the specified data
	 * @param query
	 * @param options
	 */
	subscribe(query, options) {
		// setup the subscriptions map. We want to just use a single map (per table) for efficient delegation
		// (rather than having every subscriber filter every transaction)
		if (!this.subscriptions) {
			this.subscriptions = new Map();
			onMessageFromWorkers((event) => {
				if (event.type === TRANSACTION_EVENT_TYPE) {
					let flag_position = event.start;
					let buffers = event.buffers;
					// TODO: Read from these buffers, call subscriptions handlers
					//let handlers = this.subscriptions.get(key);
					//if (handlers) handlers.forEach(handler => handler(type));
				}
			});
		}
		let key = query.conditions[0].search_attribute;
		let handlers = this.subscriptions.get(key);
		if (!handlers)
			this.subscriptions.set(key, handlers = []);
		handlers.push(options.callback);
		return {
			// return an object that we can use to end the subscription
			end() {
				handlers.splice(handlers.indexOf(options.callback), 1);
			}
		};
	}
	transaction(env_transaction, lmdb_txn, parent_transaction) {
		return new this.Transaction(env_transaction, lmdb_txn, parent_transaction, {});
	}
}
function makeTransactionClass(table: Table) {
	const { primaryKey: primary_key, indices, attributes, primaryDbi: primary_dbi, expirationMS: expiration_ms } = table;
	return class TableTransaction extends Resource {
		table: any
 		envTxn: EnvTransaction
		parent: Resource
		lmdbTxn: any
		lastAccessTime: number = 0
		static Source: { new(): ResourceInterface }

		constructor(env_txn, lmdb_txn, parent, settings) {
			super(settings, false);
			this.envTxn = env_txn;
			this.lmdbTxn = lmdb_txn;
			this.parent = parent;
			if (settings.readOnly)
				this.lmdbTxn = primary_dbi.useReadTransaction();

		}
		updateAccessTime(latest = Date.now()) {
			if (latest > this.lastAccessTime) {
				this.lastAccessTime = latest;
				if (this.parent?.updateAccessTime)
					this.parent.updateAccessTime(latest);
			}
		}
		async get(id) {
			// TODO: determine if we use lazy access properties
			let env_txn = this.envTxn;
			let entry = primary_dbi.getEntry(id, { transaction: env_txn.getReadTxn() });
			if (!entry) {
				if (TableTransaction.Source) return this.getFromSource(id);
				return;
			}
			if (env_txn.fullIsolation) {
				env_txn.recordRead(primary_dbi, id, entry.version, true);
			}
			if (entry.version > this.lastAccessTime) {
				this.updateAccessTime(entry.version);
			}

			let record = entry?.value;
			if (record) {
				//record = new Record(re)
				record[TXN_KEY] = this;
				let availability = record.__availability__;
				if (availability?.cached & INVALIDATED) {
					// TODO: If cold storage/alternate storage is available, retrieve from there

					if (availability.residence) {
						// TODO: Implement retrieval from other nodes once we have horizontal caching

					}
					if (TableTransaction.Source) return this.getFromSource(id, record);
				} else if (expiration_ms && expiration_ms < Date.now() - entry.version) {
					// TTL/expiration has some open questions, is it tenable to do it with replication?
					// What if there is no source?
					if (TableTransaction.Source) return this.getFromSource(id, record);
				}
				return record;
			}
		}

		/**
		 * This will be used to record that a record is being resolved
		 */
		async getFromSource(id, record?: any) {
			if (!record)
				record = {};
			let availability = record.__availability__ || {};
			availability.resolving = true;
			record.__availability__ = availability;
			// TODO: We want to eventually use a "direct write" method to directly write to the availability portion
			// of the record in place in the database. In the meantime, should probably use an ifVersion
			primary_dbi.put(id, record);
			let source = new TableTransaction.Source();
			let updated_record = await source.get(id);
			let updated = source.lastAccessTime;
			if (updated) {
				updated_record.__updated__ = updated;
			}
			updated_record.__availability__ = {residence: [/*here*/], cached: true};
			updated_record[primary_key] = id;
			this.put(id, updated_record, {ifVersion: updated});
			return updated_record;
		}

		put(id, record, options): void {
			let env_txn = this.envTxn;
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

			//setTimestamps(record, !had_existing, generate_timestamps);
			if (
				Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME]) &&
				existing_record[UPDATED_TIME_ATTRIBUTE_NAME] > record[UPDATED_TIME_ATTRIBUTE_NAME]
			) {
				// This is not an error condition in our world of last-record-wins
				// replication. If the existing record is newer than it just means the provided record
				// is, well... older. And newer records are supposed to "win" over older records, and that
				// is normal, non-error behavior.
				return;
			}
			let completion;

			let writes = [{
				store: primary_dbi,
				operation: 'put',
				key: id,
				value: record,
				version: record[UPDATED_TIME_ATTRIBUTE_NAME],
			}];
			// iterate the entries from the record
			// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
			// inside a write transaction
			for (let i = 0, l = indices.length; i < l; i++) {
				let index = indices[i];
				let value = record[primary_key];
				let existing_value = existing_record[primary_key];
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
						writes.push({ store: index, operation: 'remove', key: values[i], value: id, version: undefined });
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
						writes.push({ store: index, operation: 'put', key: values[i], value: id, version: undefined });
					}
				}
			}

			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			//  during the write transaction.
			env_txn.recordRead(primary_dbi, id, existing_entry ? existing_entry.version : null, false);
			env_txn.writes.push(...writes);
		}

		delete(id, options): boolean {
			let env_txn = this.envTxn;
			let existing_entry = primary_dbi.getEntry(id);
			let existing_record = existing_entry?.value;
			if (!existing_record) return false;
			env_txn.recordRead(primary_dbi, id, existing_entry.version, false);
			for (let i = 0, l = indices.length; i < l; i++) {
				let index = indices[i];
				let existing_value = existing_record[id];

				//if the update cleared out the attribute value we need to delete it from the index
				let values = common.getIndexedValues(existing_value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({key: v, value: id})),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						env_txn.writes.push({db: index, operations: 'remove', key: values[i], value: id});
					}
				}
			}
		}

		async* search(query, options): AsyncIterable<any> {
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
			let search_type = sorted_conditions[0].search_type;

			// both AND and OR start by getting an iterator for the ids for first condition
			let first_search = sorted_conditions[0];
			let ids = idsForCondition(first_search);
			// and then things diverge...
			let records;
			if (!query.operator || query.operator.toLowerCase() === 'and') {
				// get the intersection of condition searches by using the indexed query for the first condition
				// and then filtering by all subsequent conditions
				let filters = sorted_conditions.slice(1).map(filterByType);
				let filters_length = filters.length;
				records = ids.map((id) => primary_dbi.get(id, { transaction: this.lmdbTxn, lazy: true }));
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
			} else {
				//get the union of ids from all condition searches
				for (let i = 1; i < sorted_conditions.length; i++) {
					let condition = sorted_conditions[i];
					// might want to lazily execute this after getting to this point in the iteration
					let next_ids = idsForCondition(condition);
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
				records = ids.map((id) => primary_dbi.get(id, { transaction: this.lmdbTxn, lazy: true }));
			}
			return records;
		}
		subscribe(query, options) {
			return this.table.subscribe(query, options);
		}

	}
	function idsForCondition(search_condition) {
		let start = search_condition.value;
		let end, inclusiveEnd, inclusiveStart, filter;
		switch (search_condition.type) {
			case lmdb_terms.SEARCH_TYPES.EQUALS: case undefined:
				end = search_condition.value;
				inclusiveEnd = true;
		}
		let index = indices[search_condition.attribute];
		let is_primary_key = search_condition.attribute === primary_key;
		let range_options = { start, end, inclusiveEnd, values: !is_primary_key};
		if (is_primary_key) {
			return index.getRange(range_options);
		} else {
			return index.getRange(range_options).map(({ value }) => value);
		}
	}
}


function createRecordClass() {
	return class Record {
		async lock() {
			throw new Error('Lock not implemented yet');
		}
		save() {
			let table_transaction = this[TXN_KEY];
			return table_transaction.put(this);
		}
		get update() {
			// TODO: Create a proxy that provides CRDT-level operation tracking that can be saved as a set of granular, mergeable updates
			return this;
		}
	}
}
/**
 *
 * @param {SearchObject} search_object
 * @returns {({}) => boolean}
 */
export function filterByType(search_object) {
	const search_type = search_object.search_type;
	const attribute = search_object.search_attribute;
	const search_value = search_object.search_value;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return (record) => record[attribute] === search_value;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return (record) => typeof record[attribute] === 'string' && record[attribute].includes(search_value);
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].endsWith(search_value);
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].startsWith(search_value);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			return (record) => {
				let value = record[attribute];
				return compareKeys(value, search_value[0]) >= 0 && compareKeys(value, search_value[1]) <= 0;
			};
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return (record) => compareKeys(record[attribute], search_value) > 0;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], search_value) >= 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return (record) => compareKeys(record[attribute], search_value) < 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], search_value) <= 0;
		default:
			return Object.create(null);
	}
}


function noop() {
	// prefetch callback
}
export function snake_case(camelCase: string) {
	return camelCase[0].toLowerCase() + camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g,
		(letters) => letters[0] + '_' + letters.slice(1));
}
