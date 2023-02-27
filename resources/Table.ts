import { CONFIG_PARAMS, TIME_STAMP_NAMES_ENUM } from '../utility/hdbTerms';
import { open, Database } from 'lmdb';
import common from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { randomUUID } from 'crypto';
import { ResourceInterface } from './ResourceInterface';
import { workerData } from 'worker_threads';
import { EnvTransaction, Resource } from './Resource';
import { compareKeys, readKey } from 'ordered-binary';
import { onMessageFromWorkers, broadcast } from '../server/threads/manage-threads';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';
import {addSubscription, listenToCommits} from './transactionBroadcast';

const RANGE_ESTIMATE = 100000000;
env_mngr.initSync();
let b = Buffer.alloc(1);
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const CREATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const LAZY_PROPERTY_ACCESS = { lazy: true };
const TXN_KEY = Symbol('transaction');

const INVALIDATED = 16;

/*interface Table {
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
}*/
/**
 * This returns a Table class for the given table settings (determined from the metadata table)
 * Instances of the returned class are Resource instances, intended to provide a consistent view or transaction of the table
 * @param options
 */
export function makeTable(options) {
	let { primaryKey: primary_key, indices, attributes, tableName: table_name, primaryDbi: primary_dbi, expirationMS: expiration_ms } = options;
	if (!attributes) attributes = [];
	listenToCommits(primary_dbi);
	let primary_key_attribute = attributes.find(attribute => attribute.is_primary_key) || {};
	return class Table extends Resource {
		static primaryDbi = primary_dbi;
		static primaryKey = primary_key;
		static tableName = table_name;
		static indices = indices;
		static envPath = primary_dbi.env.path;
		static expirationTimer;
		static sourcedFrom(Resource) {
			// define a source for retrieving invalidated entries for caching purposes
			this.Source = Resource;
		}
		/**
		 * Set TTL expiration for records in this table
		 * @param expiration_time Time in seconds
		 */
		static setTTLExpiration(expiration_time) {
			// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
			// so we use the first one
			if (workerData?.isFirst) {
				if (!this.expirationTimer) {
					let expiration_ms = expiration_time * 1000;
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
		static subscribe(query, options) {
			let key = typeof query !== 'object' ? query : query.conditions[0].attribute;
			return addSubscription(this.primaryDbi.env.path, this.primaryDbi.db.dbi, key, options.callback);
		}
		static transaction(env_transaction, lmdb_txn, parent_transaction) {
			return new this(env_transaction, lmdb_txn, parent_transaction, {});
		}
		table: any
 		envTxn: EnvTransaction
		parent: Resource
		lmdbTxn: any
		lastModificationTime: number = 0
		static Source: { new(): ResourceInterface }

		constructor(request, env_txn, lmdb_txn, parent) {
			super(request, false);
			if (!env_txn) {
				env_txn = new EnvTransaction(primary_dbi);
				lmdb_txn = env_txn.getReadTxn();
			}
			this.envTxn = env_txn;
			this.lmdbTxn = lmdb_txn;
			this.inUseEnvs[Table.envPath] = env_txn;
			this.parent = parent;
			if (request.readOnly)
				this.lmdbTxn = primary_dbi.useReadTransaction();

		}
		updateModificationTime(latest = Date.now()) {
			if (latest > this.lastModificationTime) {
				this.lastModificationTime = latest;
				if (this.parent?.updateModificationTime)
					this.parent.updateModificationTime(latest);
			}
		}
		async getById(id) {
			// TODO: determine if we use lazy access properties
			if (primary_key_attribute.is_number)
				id = +id;
			let env_txn = this.envTxn;
			let entry = primary_dbi.getEntry(id, { transaction: env_txn.getReadTxn() });
			if (!entry) {
				if (this.constructor.Source) return this.getFromSource(id);
				return;
			}
			if (entry.version > this.lastModificationTime) {
				this.updateModificationTime(entry.version);
			}

			let record = entry?.value;
			if (record) {
				record[TXN_KEY] = this;
				let availability = record.__availability__;
				if (availability?.cached & INVALIDATED) {
					// TODO: If cold storage/alternate storage is available, retrieve from there

					if (availability.residence) {
						// TODO: Implement retrieval from other nodes once we have horizontal caching

					}
					if (this.constructor.Source) return this.getFromSource(id, record);
				} else if (expiration_ms && expiration_ms < Date.now() - entry.version) {
					// TTL/expiration has some open questions, is it tenable to do it with replication?
					// What if there is no source?
					if (this.constructor.Source) return this.getFromSource(id, record);
				}
				return record;
			}
		}
		allowGet(user) {
			if (!user) return false;
			let permission = user.role.permission;
			return permission.super_user || permission[table_name]?.read;
		}
		update(record) {
			const start_updating = (record_data) => {
				// maybe make this a map so if the record is already updating, return the same one
				let record = getWritableRecord(record_data);
				let env_txn = this.envTxn;
				// record in the list of updating records so it can be written to the database when we commit
				if (!env_txn.updatingRecords) env_txn.updatingRecords = [];
				env_txn.updatingRecords.push({ txn: this, record });
				return record;
			}
			// handle the case of the argument being a record
			if (typeof record === 'object' && record) {
				return start_updating(record);
			} else { // handle the case of the argument being a key
				return this.get(record).then(start_updating);
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
			let source = new this.constructor.Source();
			let updated_record = await source.get(id);
			let updated = source.lastModificationTime;
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
			let conditions = query.conditions || query;
			for (let condition of conditions) {
				let attribute = attributes.find(attribute => attribute.name == condition.attribute);
				if (!attribute) {
					// TODO: Make it a 404
					throw new Error(`${condition.attribute} is not a defined attribute`);
				}
				if (attribute.is_number) // convert to a number if that is expected
					condition.value = +condition.value;
			}
			// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
			// it allows us to do minimal filtering, and for union where we can return the fastest results first
			// in an iterator/stream.
			conditions = sortBy(conditions, (condition) => {
				if (condition.estimated_count === undefined) {
					// skip if it is cached
					let search_type = condition.type;
					if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS) {
						// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
						let index = indices[condition.attribute];
						condition.estimated_count = index ? index.getValuesCount(condition.value) : Infinity;
					} else if (search_type === lmdb_terms.SEARCH_TYPES.CONTAINS || search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH)
						condition.estimated_count = Infinity;
						// this search types can't/doesn't use indices, so try do them last
					// for range queries (betweens, starts-with, greater, etc.), just arbitrarily guess
					else condition.estimated_count = RANGE_ESTIMATE;
				}
				return condition.estimated_count; // use cached count
			});
			let search_type = conditions[0].type;

			// both AND and OR start by getting an iterator for the ids for first condition
			let first_search = conditions[0];
			let ids = idsForCondition(first_search);
			// and then things diverge...
			let records;
			if (!query.operator || query.operator.toLowerCase() === 'and') {
				// get the intersection of condition searches by using the indexed query for the first condition
				// and then filtering by all subsequent conditions
				let filters = conditions.slice(1).map(filterByType);
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
				for (let i = 1; i < conditions.length; i++) {
					let condition = conditions[i];
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
			return this.constructor.subscribe(query, options);
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
		if (!index) {
			throw new Error(`${search_condition.attribute} is not indexed, can not search for this attribute`);
		}
		let is_primary_key = search_condition.attribute === primary_key;
		let range_options = { start, end, inclusiveEnd, values: !is_primary_key};
		if (is_primary_key) {
			return index.getRange(range_options);
		} else {
			return index.getRange(range_options).map(({ value }) => value);
		}
	}
}
const RECORD_CLASS = Symbol('writable-record-class');
const SOURCE_SYMBOL = Symbol.for('source');
// perhaps we want these in the global registry, not sure:
export const DATA = Symbol('original-data'); // property that references the original (readonly) record for a writable record
export const OWN = Symbol('own'); // property that references an object with any changed properties or cloned/writable sub-objects
const record_class_cache = {}; // we cache the WriteableRecord classes because they are pretty expensive to create

// fast path to instantiating a WritableRecord instance for a record, that gives users the ability to make changes,
// have those changes be tracked, and then have those changes be committed when the transaction commits
function getWritableRecord(record_data) {
	let WritableRecord = record_data[RECORD_CLASS];
	if (!WritableRecord) {
		// TODO: if it is an array, need a tracking array class
		let has_distinct_stable_prototype = record_data[SOURCE_SYMBOL]; // if we can rely on a stable structure/shape based on the prototype
		let from = has_distinct_stable_prototype ? record_data.constructor.prototype : record_data;
		let next: any = record_class_cache;
		for (let key in from) {
			next = next[key] || (next[key] = {})
		}
		WritableRecord = next.__copy__ || (next.__copy__ = createWritableRecordClass(from));
		if (has_distinct_stable_prototype)
			from[RECORD_CLASS] = WritableRecord;
	}
	return new WritableRecord(record_data);
}

/**
 * If we didn't have a cached WritableRecord, actually create the class here (this is expensive)
 * @param from
 */
function createWritableRecordClass(from) {
	class WritableRecord {
		constructor(data) {
			this[DATA] = data;
			this[OWN] = {};
		}
		toJSON() {
			return Object.assign({}, this[DATA], this[OWN]);
		}
	}
	let prototype = WritableRecord.prototype;
	// define getters and setters for each property so we can track any changes and for getters either return the
	// changed value or the original value from the original record
	for (let key in from) {
		// make the key safe; we could probably add a fast path for safe key names
		let str_key = JSON.stringify(key);
		Object.defineProperty(prototype, key, {
			// this is an eval-free version of the getter, but due to the polymorphic nature of the property access is much slower
			// get() { return prop in this.own ? this.own[prop] : this.data[prop]; },
			// eval-based that allows each function to have monomorphic property access (FAST)
			get: new Function('copy', 'DATA', 'OWN', `
						return function() {
						let v = ${str_key} in this[OWN] ? this[OWN][${str_key}] : this[DATA][${str_key}];
						if (typeof v === 'osbject' && v) return this[OWN][${str_key}] = copy(v); else return v; };`)(getWritableRecord, DATA, OWN),
			// perhaps eval-based would be here, but expect setters to be less frequently used
			set(value) {
				this[OWN][key] = value;
			},
			enumerable: true,
		});
	}
	return WritableRecord;
}
/**
 *
 * @param {SearchObject} search_object
 * @returns {({}) => boolean}
 */
export function filterByType(search_object) {
	const search_type = search_object.type;
	const attribute = search_object.attribute;
	const value = search_object.value;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return (record) => record[attribute] === value;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return (record) => typeof record[attribute] === 'string' && record[attribute].includes(value);
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].endsWith(value);
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].startsWith(value);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			return (record) => {
				let value = record[attribute];
				return compareKeys(value, value[0]) >= 0 && compareKeys(value, value[1]) <= 0;
			};
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return (record) => compareKeys(record[attribute], value) > 0;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) >= 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return (record) => compareKeys(record[attribute], value) < 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) <= 0;
		default:
			return Object.create(null);
	}
}


function noop() {
	// prefetch callback
}
export function snake_case(camelCase: string) {
	return camelCase[0].toLowerCase() + camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g,
		(letters) => letters[0] + '_' + letters[1].toLowerCase() + letters.slice(2));
}
