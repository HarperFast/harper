import { ResourceInterface } from './ResourceInterface';
import { getTables } from './databases';
import { Table } from './Table';
import { randomUUID } from 'crypto';
import { DatabaseTransaction, Transaction } from './DatabaseTransaction';
import { DefaultAccess } from './Access';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { IterableEventQueue } from './IterableEventQueue';
import { _assignPackageExport } from '../index';
import { ClientError } from '../utility/errors/hdbError';

let tables;

export const CONTEXT_PROPERTY = Symbol.for('context');
export const USER_PROPERTY = Symbol.for('user');
export const ID_PROPERTY = Symbol.for('id');
export const LAST_MODIFICATION_PROPERTY = Symbol.for('last-modification-time');
export const TRANSACTIONS_PROPERTY = Symbol('transactions');
export const IS_COLLECTION = Symbol('is-collection');
export const SAVE_UPDATES_PROPERTY = Symbol('save-updates');
export const RESOURCE_CACHE = Symbol('resource-cache');
export const RECORD_PROPERTY = Symbol('stored-record');
export const EXPLICIT_CHANGES_PROPERTY = Symbol.for('explicit-changes');
export const USED_RESOURCES = Symbol('used-resources');

/**
 * This is the main class that can be extended for any resource in HarperDB and provides the essential reusable
 * uniform interface for interacting with data, defining the API for providing data (data sources) and for consuming
 * data. This interface is used pervasively in HarperDB and is implemented by database tables and can be used to define
 * sources for caching, real-data sources for messaging protocols, and RESTful endpoints, as well as any other types of
 * data aggregation, processing, or monitoring.
 */
export class Resource implements ResourceInterface {
	[CONTEXT_PROPERTY]: any;
	[USER_PROPERTY]: any;
	[ID_PROPERTY]: any;
	[LAST_MODIFICATION_PROPERTY] = 0;
	[TRANSACTIONS_PROPERTY]: Transaction[] & { timestamp: number };
	static transactions: Transaction[] & { timestamp: number };
	constructor(identifier?, source?) {
		this[ID_PROPERTY] = identifier;
		this[CONTEXT_PROPERTY] = source?.[CONTEXT_PROPERTY];
		this[USER_PROPERTY] = this[CONTEXT_PROPERTY]?.user;
		this[TRANSACTIONS_PROPERTY] = source?.[TRANSACTIONS_PROPERTY];
	}

	getById(id: any, options?: any): Promise<{}> {
		throw new Error('Not implemented');
	}

	/**
	 * Resources track the last modified time, which is essential for all caching layers in a system (and beyond to
	 * clients that may do caching). Any type a source is accessed with a modification time, this can be called to ensure
	 * the current resource has this time or later as its aggregate modification time.
	 * @param latest
	 */
	updateModificationTime(latest = Date.now()) {
		if (latest > this[LAST_MODIFICATION_PROPERTY]) {
			this[LAST_MODIFICATION_PROPERTY] = latest;
		}
	}

	/**
	 * Commit the resource transaction(s). This commits any transactions that have started as part of the resolution
	 * of this resource, and frees any read transaction.
	 */
	async commit(flush = true): Promise<{ txnTime: number }> {
		const commits = [];
		// this can grow during the commit phase, so need to always check length
		try {
			for (let i = 0; i < this[TRANSACTIONS_PROPERTY].length; i++) {
				const txn = this[TRANSACTIONS_PROPERTY][i];
				txn.validate?.();
			}
			for (let i = 0; i < this[TRANSACTIONS_PROPERTY].length; ) {
				for (let l = this[TRANSACTIONS_PROPERTY].length; i < l; i++) {
					const txn = this[TRANSACTIONS_PROPERTY][i];
					// TODO: If we have multiple commits in a single resource instance, need to maintain
					// databases with waiting flushes to resolve at the end when a flush is requested.
					commits.push(txn.commit(flush));
				}
				await Promise.all(commits);
			}
			return { txnTime: this[TRANSACTIONS_PROPERTY].timestamp };
		} finally {
			this[TRANSACTIONS_PROPERTY] = null;
		}
	}
	static commit = Resource.prototype.commit;
	abort() {
		for (const txn of this[TRANSACTIONS_PROPERTY]) {
			txn.abort?.();
		}
	}
	static abort = Resource.prototype.abort;
	doneReading() {
		for (const txn of this[TRANSACTIONS_PROPERTY]) {
			txn.doneReading?.();
		}
	}
	static async get(identifier: string | number | (string | number)[]): Promise<object>;
	static async get(query: object): Promise<Iterable<object>>;
	static async get(identifier: string | number | (string | number)[] | object, query) {
		const resource = await this.getResource(identifier, this);
		return resource.get(query);
	}

	doesExist(): boolean;
	/**
	 * This retrieves the data of this resource. By default, with no argument, just return `this`.
	 * @param query - If included, specifies a query to perform on the record
	 */
	get(query?: object): Promise<object | void> | object | void {
		if (this[IS_COLLECTION]) {
			return this.search(query);
		}
		if (typeof this.doesExist !== 'function' || this.doesExist()) {
			if (query?.select) {
				const selected_data = {};
				const forceNulls = query.select.forceNulls;
				for (const property of query.select) {
					let value = this[property];
					if (typeof value === 'function') value = this[EXPLICIT_CHANGES_PROPERTY]?.[property];
					if (value === undefined && forceNulls) value = null;
					selected_data[property] = value;
				}
				return selected_data;
			} else if (this[EXPLICIT_CHANGES_PROPERTY]) {
				const aggregated_data = {};
				for (const property in this) aggregated_data[property] = this[property];
				for (const key in this[EXPLICIT_CHANGES_PROPERTY]) aggregated_data[key] = this[EXPLICIT_CHANGES_PROPERTY][key];
				return aggregated_data;
			}
			return this;
		}
	}
	getProperty(name) {
		const value = this[name];
		if (typeof value === 'function') return this[EXPLICIT_CHANGES_PROPERTY]?.[name];
		return value;
	}
	setProperty(name, value) {
		if (typeof this[name] === 'function') {
			const explicit_changes = this[EXPLICIT_CHANGES_PROPERTY] || (this[EXPLICIT_CHANGES_PROPERTY] = {});
			explicit_changes[name] = value;
		} else this[name] = value;
	}

	put(record: object, options?): Promise<void>;
	static getNewId() {
		return randomUUID();
	}

	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 * @param id?
	 * @param record
	 * @param options
	 */
	static async put(id, record, options?): void {
		if (typeof id === 'object') {
			// id is optional
			options = record;
			record = id;
			id = null;
		}
		if (id == null) id = record[this.primaryKey];
		if (id == null) return this.create(record, options);
		const resource = this.getResource(id, this);
		return resource.transact(async (txn_resource) => {
			return txn_resource.put(record, options);
		});
	}
	static async create(record, options?): void {
		const id = this.getNewId(); //uuid.v4();
		const resource = this.getResource(id, this);
		return resource.transact(async (txn_resource) => {
			await txn_resource.put(record, options);
			return id;
		});
	}
	post(new_record) {
		if (this[ID_PROPERTY] == null)
			return this.constructor.create(new_record);
		throw new Error('No post method defined for resource');
	}

	static async delete(identifier: string | number | object) {
		if (typeof identifier === 'string' || typeof identifier === 'number') {
			const resource = this.getResource(identifier, this);
			return resource.transact(async (txn_resource) => {
				return txn_resource.delete();
			});
		} else {
			return this.transact((resource_txn) => {
				const completions = [];
				if (this.prototype.delete.preload === false) identifier.select = [this.primaryKey];
				for (const record of resource_txn.search(identifier)) {
					const record_resource = new this(record[this.primaryKey], this[CONTEXT_PROPERTY], resource_txn.transaction);
					record_resource.record = record;
					completions.push(record_resource.delete());
				}
				return Promise.all(completions);
			});
		}
	}

	static search(query: object): AsyncIterable<object> {
		return (new this(null)).search(query);
	}
	search(query: object): AsyncIterable<object> {
		throw new ClientError('search is not implemented');
	}

	static isCollection(resource) {
		return resource?.[IS_COLLECTION];
	}
	static coerceId(id: string): number | string {
		return id;
	}
	static getResource(id: number | string | (number | string | null)[] | null, resource_info: object, path): Resource | Promise<Resource> {
		let resource;
		if (!path) {
			path = id?.toString() ?? '';
		}
		if (this[TRANSACTIONS_PROPERTY]) {
			let resource_cache;
			if (this.hasOwnProperty(RESOURCE_CACHE)) {
				resource_cache = this[RESOURCE_CACHE];
				resource = resource_cache.get(path);
				if (resource) return resource;
			} else resource_cache = this[RESOURCE_CACHE] = new Map();
			resource_cache.set(path, (resource = new this(id, resource_info)));
		} else resource = new this(id, resource_info);
		if (id == null || id.constructor === Array && id[id.length - 1] == null)
			resource[IS_COLLECTION] = true;
		return resource;
	}

	/**
	 * This is called by protocols that wish to make a subscription for real-time notification/updates
	 * @param query
	 * @param options
	 */
	subscribe(query: any, options?: {}): AsyncIterable<{ id: any; operation: string; value: object }>;
	static subscribe(query: any, options?: {}): AsyncIterable<{ id: any; operation: string; value: object }>;
	connect(query?: {}): AsyncIterable<any> {
		// convert subscription to an (async) iterator
		const iterable = new IterableEventQueue();
		if (query?.subscribe !== false) {
			// subscribing is the default action, but can be turned off
			const options = {
				listener: (message) => {
					iterable.send(message);
				},
			};
			const subscription = this.subscribe?.(options);
			iterable.on('close', () => subscription?.end());
		}
		return iterable;
	}
	static connect = Resource.prototype.connect;

	/**
	 * This used to indicate that this resource will use another resource to compute its data. Doing this will include
	 * the other resource in the resource snapshot and track timestamps of data used from that resource, allowing for
	 * automated modification/timestamp handling.
	 * @param ResourceToUse
	 */
	use(ResourceToUse: typeof Resource, identifier: string | number) {
		let used_resources = this[USED_RESOURCES];
		if (used_resources) {
			const used = used_resources.find((used) => used === Resource || ResourceToUse.isPrototypeOf(used));
			if (used) return used;
		} else this[USED_RESOURCES] = used_resources = [];
		const txn_resource = ResourceToUse.deriveWithTransactions(this[TRANSACTIONS_PROPERTY], this[CONTEXT_PROPERTY]);
		used_resources.push(txn_resource);
		txn_resource[USED_RESOURCES] = used_resources;
		if (identifier) return txn_resource.get(identifier);
		return txn_resource;
	}
	update(keyOrRecord) {
		throw new Error('Not implemented');
	}
	useTable(table_name: string, schema_name?: string): ResourceInterface {
		if (!tables) tables = getTables();
		const schema_object = schema_name ? tables[schema_name] : tables;
		const table: Table = schema_object?.[table_name];
		if (!table) return;
		const key = schema_name ? schema_name + '/' + table_name : table_name;
		const env_path = table.envPath;
		const env_txn =
			this[TRANSACTIONS_PROPERTY][env_path] ||
			(this[TRANSACTIONS_PROPERTY][env_path] = new DatabaseTransaction(
				table.primaryStore,
				this[USER_PROPERTY],
				table.auditStore
			));
		return table.transaction(this[CONTEXT_PROPERTY], env_txn, env_txn.getReadTxn(), this);
	}
	async fetch(input: RequestInfo | URL, init?: RequestInit) {
		const response = await fetch(input, init);
		const method = init?.method || 'GET';
		if (method === 'GET' && response.status === 200) {
			// we are accumulating most recent times for the sake of making resources cacheable
			const last_modified = response.headers['last-modified'];
			if (last_modified) {
				this.updateModificationTime(Date.parse(last_modified));
				return response;
			}
		}
		// else use current time
		this.updateModificationTime();
		return response;
	}
	static set transaction(t) {
		throw new Error('Can not set transaction on base Resource class');
	}
	static deriveWithTransactions(transactions, options) {
		const name = this.name + ' (txn)';
		return class extends this {
			// @ts-ignore
			static name = name;
			static [TRANSACTIONS_PROPERTY] = transactions;
			static [CONTEXT_PROPERTY] = options;
		};
	}
	static transact(callback, options?) {
		if (this[TRANSACTIONS_PROPERTY]) return callback(this);
		const transactions = [];
		transactions.timestamp = options?.timestamp || getNextMonotonicTime();

		const txn_resource = this.deriveWithTransactions(transactions, options);
		return executeTransaction(txn_resource, callback);
	}
	transact(callback, options?) {
		if (this[TRANSACTIONS_PROPERTY]) return callback(this);
		const transactions = [];
		transactions.timestamp = options?.timestamp || getNextMonotonicTime();
		this[TRANSACTIONS_PROPERTY] = transactions;
		return executeTransaction(this, callback);
	}
	async accessInTransaction(request, action: (resource_access) => any) {
		return this.transact((transactional_resource) => {
			if (request) {
				transactional_resource[CONTEXT_PROPERTY] = request;
				transactional_resource[USER_PROPERTY] = request.user;
			}
			const resource_access = transactional_resource.access(request);
			return action(resource_access);
		});
	}
	static accessInTransaction = Resource.prototype.accessInTransaction;
	static access(request) {
		return new this.Access(request, this);
	}
	access(request) {
		return new this.constructor.Access(request, this);
	}
	static Access = DefaultAccess;

	// Default permissions (super user only accesss):
	static allowRead(user, query?: object): boolean | object {
		return user?.role.permission.super_user;
	}
	allowRead(user, query?: object): boolean | object {
		return this.constructor.allowRead(user, query);
	}
	static allowUpdate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowUpdate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	static allowCreate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowCreate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	static allowDelete(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowDelete(user): boolean | object {
		return user?.role.permission.super_user;
	}
}
Resource.prototype.get.doesNotLoad = true; // the default get implementation does not actually load anything
_assignPackageExport('Resource', Resource);

export function snake_case(camelCase: string) {
	return (
		camelCase[0].toLowerCase() +
		camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters.slice(1))
	);
}

function checkAllowed(method_allowed, user, resource): void | Promise<void> {
	const allowed = method_allowed ?? resource.allowAccess?.() ?? user?.role.permission.super_user; // default permission check
	if (allowed?.then) {
		// handle promises, waiting for them using fast path (not await)
		return allowed.then(() => {
			if (!allowed) checkAllowed(false, user, resource);
		});
	} else if (!allowed) {
		let error;
		if (user) {
			error = new Error('Unauthorized access to resource');
			error.status = 403;
		} else {
			error = new Error('Must login');
			error.status = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
		throw error;
	}
}

// Copy a record into a resource, using copy-on-write for nested objects/arrays
export function copyRecord(record, target_resource) {
	target_resource[RECORD_PROPERTY] = record;
	for (const key in record) {
		// do not override existing methods
		if (target_resource[key] === undefined) {
			const value = record[key];
			// use copy-on-write for sub-objects
			if (typeof value === 'object' && value) setSubObject(target_resource, key, value);
			// primitives can be directly copied
			else target_resource[key] = value;
		}
	}
}
export const NOT_COPIED_YET = {};
let copy_enabled = true;
function setSubObject(target_resource, key, stored_value) {
	let value = NOT_COPIED_YET;
	Object.defineProperty(target_resource, key, {
		get() {
			if (value === NOT_COPIED_YET && copy_enabled) {
				switch (stored_value.constructor) {
					case Object:
						copyRecord(stored_value, (value = new UpdatableObject()));
						break;
					case Array:
						copyArray(stored_value, (value = new UpdatableArray()));
						break;
					default:
						value = stored_value;
				}
			}
			return value;
		},
		set(new_value) {
			value = new_value;
		},
		enumerable: true,
		configurable: true,
	});
}
export function withoutCopying(callback) {
	copy_enabled = false;
	const result = callback();
	copy_enabled = true;
	return result;
}
class UpdatableObject {
	// eventually provide CRDT functions here like add, subtract
}
class UpdatableArray extends Array {
	// eventually provide CRDT tracking for push, unshift, pop, etc.
}
function copyArray(stored_array, target_array) {
	for (let i = 0, l = stored_array.length; i < l; i++) {
		let value = stored_array[i];
		// copy sub-objects (it assumed we don't really need to lazily access entries in an array,
		// if an array is accessed, probably all elements in array will be accessed
		if (typeof value === 'object' && value) {
			if (value.constructor === Object) copyRecord(value, (value = new UpdatableObject()));
			else if (value.constructor === Array) copyArray(value, (value = new UpdatableArray()));
		}
		target_array[i] = value;
	}
}
function executeTransaction(txn_resource: Resource, callback: (resource: Resource) => any) {
	try {
		const result = callback(txn_resource);
		if (result?.then)
			return result?.then(
				async (result) => {
					await txn_resource.commit();
					return result;
				},
				(error) => {
					txn_resource.abort();
					throw error;
				}
			);
		else {
			if (txn_resource[TRANSACTIONS_PROPERTY].some((transaction) => transaction.hasWritesToCommit))
				return txn_resource.commit().then(() => result);
			txn_resource.abort();
			return result;
		}
	} catch (error) {
		txn_resource.abort();
		throw error;
	}

}