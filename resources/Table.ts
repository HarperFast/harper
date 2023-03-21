import { CONFIG_PARAMS, TIME_STAMP_NAMES_ENUM } from '../utility/hdbTerms';
import { open, Database } from 'lmdb';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { randomUUID } from 'crypto';
import { ResourceInterface } from './ResourceInterface';
import { workerData } from 'worker_threads';
import { Resource } from './Resource';
import { DatabaseTransaction } from './DatabaseTransaction';
import { compareKeys, readKey } from 'ordered-binary';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';
import { addSubscription, listenToCommits } from './transactionBroadcast';
import { getWritableRecord } from './WritableRecord';

const RANGE_ESTIMATE = 100000000;
env_mngr.initSync();
const b = Buffer.alloc(1);
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const CREATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const LAZY_PROPERTY_ACCESS = { lazy: true };
const TXN_KEY = Symbol('transaction');

const INVALIDATED = 16;

interface Table {
	primaryStore: Database;
	auditStore: Database;
	indices: Database[];
	envPath: string;
	tableName: string;
	schemaName: string;
	attributes: any[];
	primaryKey: string;
	subscriptions: Map<any, Function[]>;
	expirationTimer: ReturnType<typeof setInterval>;
	expirationMS: number;
	Source: { new (): ResourceInterface };
	Transaction: ReturnType<typeof makeTable>;
}
/**
 * This returns a Table class for the given table settings (determined from the metadata table)
 * Instances of the returned class are Resource instances, intended to provide a consistent view or transaction of the table
 * @param options
 */
export function makeTable(options) {
	let {
		primaryKey: primary_key,
		indices,
		attributes,
		tableId: table_id,
		tableName: table_name,
		primaryStore: primary_store,
		expirationMS: expiration_ms,
		auditStore: audit_store,
	} = options;
	if (!attributes) attributes = [];
	listenToCommits(primary_store);
	const primary_key_attribute = attributes.find((attribute) => attribute.is_primary_key) || {};
	return class Table extends Resource {
		static primaryStore = primary_store;
		static auditStore = audit_store;
		static primaryKey = primary_key;
		static tableName = table_name;
		static indices = indices;
		static envPath = primary_store.env.path;
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
					const expiration_ms = expiration_time * 1000;
					this.expirationTimer = setInterval(() => {
						// iterate through all entries to find expired ones
						for (const { key, value: record, version } of this.primaryStore.getRange({
							start: false,
							versions: true,
						})) {
							if (version < Date.now() - expiration_ms) {
								// make sure we only delete it if the version has not changed
								this.primaryStore.ifVersion(key, version, () => this.primaryStore.remove(key));
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
		static async subscribe(identifier, options) {
			let key = typeof identifier !== 'object' ? identifier : identifier.conditions[0].attribute;
			if (key === '' || key === '?')
				// TODO: Should this require special permission?
				key = null; // wildcard, get everything in table
			if (options?.listener && !options.noRetain && key != null) {
				const result = await this.get(identifier, options);
				const data = result?.data;
				if (data) {
					options.listener(data[primary_key], data);
				}
			}
			return addSubscription(this, key, async (key, audit_record) => {
				//let result = await this.get(key);
				options.listener(key, audit_record.value);
			});
		}
		static transaction(env_transaction, lmdb_txn, parent_transaction) {
			return new this(env_transaction, lmdb_txn, parent_transaction, {});
		}
		static async dropTable() {
			// TODO: remove all the dbi references
			for (const key in indices) {
				Table.dbisDB.remove(Table.tableName + '.' + key);
				const index = indices[key];
				index.drop();
			}
			return Table.dbisDB.committed;
		}

		table: any;
		envTxn: DatabaseTransaction;
		parent: Resource;
		lmdbTxn: any;
		lastModificationTime = 0;
		static Source: { new (): ResourceInterface };

		constructor(identifier, request, env_txn, lmdb_txn, parent) {
			// coerce if we know this is supposed to be a number
			super(identifier, request);
			if (primary_key_attribute.is_number && this.id != null) this.id = +this.id;
			if (!env_txn) {
				env_txn = new DatabaseTransaction(primary_store, request?.user, audit_store);
				lmdb_txn = env_txn.getReadTxn();
			}
			this.envTxn = env_txn;
			this.lmdbTxn = lmdb_txn;
			this.inUseEnvs[Table.envPath] = env_txn;
			this.parent = parent;
		}
		updateModificationTime(latest = Date.now()) {
			if (latest > this.lastModificationTime) {
				this.lastModificationTime = latest;
				if (this.parent?.updateModificationTime) this.parent.updateModificationTime(latest);
			}
		}

		/**
		 * This retrieves the record as a frozen object for this resource. Alternately, provide a primary key (id) to
		 * retrieve a different record from this table.
		 * @param identifier
		 */
		async get(identifier?: string | number) {
			// TODO: determine if we use lazy access properties
			const env_txn = this.envTxn;
			if (!identifier) identifier = this.id;
			const entry = primary_store.getEntry(identifier, { transaction: env_txn.getReadTxn() });
			if (!entry) {
				if (this.constructor.Source) return this.getFromSource(identifier);
				return;
			}
			if (entry.version > this.lastModificationTime) {
				this.updateModificationTime(entry.version);
			}

			const record = entry?.value;
			if (record) {
				record[TXN_KEY] = this;
				const availability = record.__availability__;
				if (availability?.cached & INVALIDATED) {
					// TODO: If cold storage/alternate storage is available, retrieve from there

					if (availability.residence) {
						// TODO: Implement retrieval from other nodes once we have horizontal caching
					}
					if (this.constructor.Source) return this.getFromSource(identifier, record);
				} else if (expiration_ms && expiration_ms < Date.now() - entry.version) {
					// TTL/expiration has some open questions, is it tenable to do it with replication?
					// What if there is no source?
					if (this.constructor.Source) return this.getFromSource(identifier, record);
				}
				return record;
			}
		}

		/**
		 * Determine if the user is allowed to get/read data from the current resource
		 * @param user
		 */
		allowGet(user) {
			if (!user) return false;
			const permission = user.role.permission;
			return permission.super_user || permission[table_name]?.read;
		}

		/**
		 * Start updating a record. The returned record will be "writable" record, which records changes which are written
		 * once the corresponding transaction is committed. These changes can (eventually) include CRDT type operations.
		 * @param record This can be a record returned from get or a record id.
		 */
		update(record) {
			const start_updating = (record_data) => {
				// maybe make this a map so if the record is already updating, return the same one
				const record = getWritableRecord(record_data);
				const env_txn = this.envTxn;
				// record in the list of updating records so it can be written to the database when we commit
				if (!env_txn.updatingRecords) env_txn.updatingRecords = [];
				env_txn.updatingRecords.push({ txn: this, record });
				return record;
			};
			// handle the case of the argument being a record
			if (typeof record === 'object' && record) {
				return start_updating(record);
			} else {
				// handle the case of the argument being a key
				return this.get(record).then(start_updating);
			}
		}

		/**
		 * This will be used to record that a record is being resolved
		 */
		async getFromSource(identifier: string | number, record?: any) {
			if (!record) record = {};
			const availability = record.__availability__ || {};
			availability.resolving = true;
			record.__availability__ = availability;
			// TODO: We want to eventually use a "direct write" method to directly write to the availability portion
			// of the record in place in the database. In the meantime, should probably use an ifVersion
			primary_store.put(identifier, record);
			const source = new this.constructor.Source();
			const updated_record = await source.get(identifier);
			const updated = source.lastModificationTime;
			if (updated) {
				updated_record.__updated__ = updated;
			}
			updated_record.__availability__ = {
				residence: [
					/*here*/
				],
				cached: true,
			};
			updated_record[primary_key] = identifier;
			this.put(this.id, updated_record, { ifVersion: updated });
			return updated_record;
		}

		/**
		 * Store the provided record by the provided id. If no id is provided, it is auto-generated. This is not written
		 * until the corresponding transaction is committed. This will either immediately fail (synchronously) or always
		 * succeed. That doesn't necessarily mean it will "win", another concurrent put could come "after" (monotonically,
		 * even if not chronologically) this one.
		 * @param id?
		 * @param record
		 * @param options
		 */
		put(id, record, options): void {
			const env_txn = this.envTxn;
			if (typeof id === 'object') {
				// id is optional
				options = record;
				record = id;
				id = this.id;
			}
			if (!id) {
				id = record[primary_key] = randomUUID(); //uuid.v4();
			}
			const existing_entry = primary_store.getEntry(id);
			let existing_record = existing_entry?.value;
			const had_existing = existing_record;
			if (!existing_record) {
				existing_record = {};
			}
			if (attributes && !options?.noValidation) {
				let validation_errors;
				/*
				for (let i = 0, l = attributes.length; i < l; i++) {
					let attribute = attributes[i];
					if (!attribute.type || attribute.type === typeof record[attribute.name]) {
						// any other validations
					} else if (attribute.required && record[attribute.name] == null) {
						(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} is required`);
					} else {
						(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} must be a ${attribute.type}`);
					}
				}*/
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

			const writes = [
				{
					store: primary_store,
					operation: 'put',
					key: id,
					value: record,
					version: record[UPDATED_TIME_ATTRIBUTE_NAME],
				},
			];
			// iterate the entries from the record
			// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
			// inside a write transaction
			// TODO: Make an array version of indices that is faster
			for (const key in indices) {
				const index = indices[key];
				const value = record[key];
				const existing_value = existing_record[key];
				if (value === existing_value) {
					continue;
				}

				//if the update cleared out the attribute value we need to delete it from the index
				let values = getIndexedValues(existing_value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({ key: v, value: id })),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						writes.push({ store: index, operation: 'remove', key: values[i], value: this.id, version: undefined });
					}
				}
				values = getIndexedValues(value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({ key: v, value: id })),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						writes.push({ store: index, operation: 'put', key: values[i], value: this.id, version: undefined });
					}
				}
			}
			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			//  during the write transaction.
			env_txn.recordRead(primary_store, this.id, existing_entry ? existing_entry.version : null, false);
			env_txn.writes.push(...writes);
		}

		delete(options): boolean {
			const env_txn = this.envTxn;
			const existing_entry = primary_store.getEntry(this.id);
			const existing_record = existing_entry?.value;
			if (!existing_record) return false;
			for (let i = 0, l = indices.length; i < l; i++) {
				const index = indices[i];
				const existing_value = existing_record[this.id];

				//if the update cleared out the attribute value we need to delete it from the index
				const values = getIndexedValues(existing_value);
				if (values) {
					if (LMDB_PREFETCH_WRITES)
						index.prefetch(
							values.map((v) => ({ key: v, value: this.id })),
							noop
						);
					for (let i = 0, l = values.length; i < l; i++) {
						env_txn.writes.push({ db: index, operations: 'remove', key: values[i], value: this.id });
					}
				}
			}
		}
		static Collection = class Collection extends Table {
			constructor(request) {
				super(null, request);
			}
		};
		search(query, options): AsyncIterable<any> {
			query.offset = Number.isInteger(query.offset) ? query.offset : 0;
			let conditions = query.conditions || query;
			for (const condition of conditions) {
				const attribute = attributes.find((attribute) => attribute.name == condition.attribute);
				if (!attribute) {
					// TODO: Make it a 404
					throw new Error(`${condition.attribute} is not a defined attribute`);
				}
				if (attribute.is_number)
					// convert to a number if that is expected
					condition.value = +condition.value;
			}
			// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
			// it allows us to do minimal filtering, and for union where we can return the fastest results first
			// in an iterator/stream.
			conditions = sortBy(conditions, (condition) => {
				if (condition.estimated_count === undefined) {
					// skip if it is cached
					const search_type = condition.type;
					if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS) {
						// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
						const index = indices[condition.attribute];
						condition.estimated_count = index ? index.getValuesCount(condition.value) : Infinity;
					} else if (
						search_type === lmdb_terms.SEARCH_TYPES.CONTAINS ||
						search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH
					)
						condition.estimated_count = Infinity;
					// this search types can't/doesn't use indices, so try do them last
					// for range queries (betweens, starts-with, greater, etc.), just arbitrarily guess
					else condition.estimated_count = RANGE_ESTIMATE;
				}
				return condition.estimated_count; // use cached count
			});
			// both AND and OR start by getting an iterator for the ids for first condition
			const first_search = conditions[0];
			let records;
			if (!first_search) {
				records = primary_store.getRange({ start: false }).map(({ value }) => value);
			} else {
				let ids = idsForCondition(first_search);
				// and then things diverge...
				if (!query.operator || query.operator.toLowerCase() === 'and') {
					// get the intersection of condition searches by using the indexed query for the first condition
					// and then filtering by all subsequent conditions
					const filters = conditions.slice(1).map(filterByType);
					const filters_length = filters.length;
					records = ids.map((id) => primary_store.get(id, { transaction: this.lmdbTxn, lazy: true }));
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
						const condition = conditions[i];
						// might want to lazily execute this after getting to this point in the iteration
						const next_ids = idsForCondition(condition);
						ids = ids.concat(next_ids);
					}
					const returned_ids = new Set();
					const offset = query.offset || 0;
					ids = ids
						.filter((id) => {
							if (returned_ids.has(id))
								// skip duplicates
								return false;
							returned_ids.add(id);
							return true;
						})
						.slice(offset, query.limit && query.limit + offset);
					records = ids.map((id) => primary_store.get(id, { transaction: this.lmdbTxn, lazy: true }));
				}
			}
			return records;
		}
		subscribe(query, options) {
			return this.constructor.subscribe(query, options);
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		publish(message, options) {
			this.envTxn.writes.push({
				store: primary_store,
				operation: 'message',
				key: this.id,
				value: message,
			});
		}
	};
	function idsForCondition(search_condition) {
		const start = search_condition.value;
		let end, inclusiveEnd, inclusiveStart, filter;
		switch (search_condition.type) {
			case lmdb_terms.SEARCH_TYPES.EQUALS:
			case undefined:
				end = search_condition.value;
				inclusiveEnd = true;
		}
		const index = indices[search_condition.attribute];
		if (!index) {
			throw new Error(`${search_condition.attribute} is not indexed, can not search for this attribute`);
		}
		const is_primary_key = search_condition.attribute === primary_key;
		const range_options = { start, end, inclusiveEnd, values: !is_primary_key };
		if (is_primary_key) {
			return index.getRange(range_options);
		} else {
			return index.getRange(range_options).map(({ value }) => value);
		}
	}
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
				const value = record[attribute];
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
	return (
		camelCase[0].toLowerCase() +
		camelCase
			.slice(1)
			.replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters[1].toLowerCase() + letters.slice(2))
	);
}
