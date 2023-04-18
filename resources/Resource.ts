import { ResourceInterface } from './ResourceInterface';
import { getTables } from './tableLoader';
import { Table } from './Table';
import { randomUUID } from 'crypto';
import { DatabaseTransaction } from './DatabaseTransaction';
import { DefaultAccess } from './Access';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
let tables;

/**
 * This is the main class that can be extended for any resource in HarperDB and provides the essential reusable
 * uniform interface for interacting with data, defining the API for providing data (data sources) and for consuming
 * data. This interface is used pervasively in HarperDB and is implemented by database tables and can be used to define
 * sources for caching, real-data sources for messaging protocols, and RESTful endpoints, as well as any other types of
 * data aggregation, processing, or monitoring.
 */
export class Resource implements ResourceInterface {
	request: any;
	user: any;
	id: any;
	property?: string;
	lastModificationTime = 0;
	inUseTables = {};
	transaction: [];
	constructor(identifier?, context?) {
		this.id = identifier;
		this.request = context?.request;
		this.user = this.request?.user;
		let transaction = context?.transaction;
		if (!transaction) {
			transaction = [];
			transaction._txnTime = getNextMonotonicTime();
		}
		this.transaction = transaction;
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
		if (latest > this.lastModificationTime) {
			this.lastModificationTime = latest;
		}
	}

	/**
	 * Commit the resource transaction(s). This commits any transactions that have started as part of the resolution
	 * of this resource, and frees any read transaction.
	 */
	async commit(flush = true): Promise<{ txnTxn: number }[]> {
		const commits = [];
		let resolved;
		// this can grow during the commit phase, so need to always check length
		for (let i = 0; i < this.transaction.length; ) {
			for (let l = this.transaction.length; i < l; i++) {
				const txn = this.transaction[i];
				// TODO: If we have multiple commits in a single resource instance, need to maintain
				// databases with waiting flushes to resolve at the end when a flush is requested.
				commits.push(txn.commit(flush));
			}
			resolved = await Promise.all(commits);
		}
		return { txnTime: this.transaction._txnTime };
	}
	static commit = Resource.prototype.commit;
	abort() {
		for (const env_path in this.transaction) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.transaction[env_path];
			env_txn.abort(); // done with the read snapshot txn
		}
	}
	doneReading() {
		for (const env_path in this.transaction) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.transaction[env_path];
			env_txn.doneReading(); // done with the read snapshot txn
		}
	}
	static async get(identifier: string | number): Promise<object>;
	static async get(query: object): Promise<Iterable<object>>;
	static async get(identifier: string | number | object) {
		if (typeof identifier === 'string' || typeof identifier === 'number') {
			const resource = this.getResource(identifier, this);
			await resource.loadRecord();
			return resource.get();
		} else {
			// could conditionally skip the mapping if get is not overriden
			return this.transact(async (resource_txn) =>
				(await resource_txn.search(identifier)).map((record) =>
					resource_txn.resourceFromRecord(record, this.request).get()
				)
			);
		}
	}
	static getNewId() {
		return randomUUID();
	}

	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 * @param id?
	 * @param record
	 * @param options
	 */
	static async put(id, record, options): void {
		if (typeof id === 'object') {
			// id is optional
			options = record;
			record = id;
			id = null;
		}
		if (id == null) id = record[this.primaryKey];
		if (id == null) id = this.getNewId(); //uuid.v4();
		const resource = this.getResource(id, this);
		return resource.transact(async (txn_resource) => {
			await txn_resource.loadRecord();
			return txn_resource.put(record, options);
		});
	}

	static async delete(identifier: string | number | object) {
		if (typeof identifier === 'string' || typeof identifier === 'number') {
			const resource = this.getResource(identifier, this);
			return resource.transact(async (txn_resource) => {
				if (txn_resource.delete.preload !== false) {
					await txn_resource.loadRecord();
				}
				return txn_resource.delete();
			});
		} else {
			return this.transact((resource_txn) => {
				const completions = [];
				if (this.prototype.delete.preload === false) identifier.select = [this.primaryKey];
				for (const record of resource_txn.search(identifier)) {
					const record_resource = new this(record[this.primaryKey], this.request, resource_txn.transaction);
					record_resource.record = record;
					completions.push(record_resource.delete());
				}
				return Promise.all(completions);
			});
		}
	}

	static async search(query: object): Promise<Iterable<object>> {
		throw new Error('Not implemented');
	}
	async loadRecord() {
		// nothing to be done by default, Table implements an actual real version of this
	}
	static resourceFromRecord(record) {
		const resource = new this(record[this.primaryKey]);
		resource.record = record;
		resource.transaction = this.transaction;
		return resource;
	}
	static getResource(path: string, resource_info: object) {
		let resource;
		if (typeof path === 'string') {
			const slash_index = path.indexOf?.('/');
			if (slash_index > -1) {
				resource = new this(decodeURIComponent(path.slice(0, slash_index)), resource_info);
				resource.property = decodeURIComponent(path.slice(slash_index + 1));
			} else {
				resource = new this(decodeURIComponent(path), resource_info);
			}
		} else resource = new this(path, resource_info);
		return resource;
	}

	/**
	 * This is called by protocols that wish to make a subscription for real-time notification/updates
	 * @param query
	 * @param options
	 */
	subscribe(query: any, options?: {}) {
		throw new Error('Not implemented');
	}

	/**
	 * This used to indicate that this resource will use another resource to compute its data. Doing this will include
	 * the other resource in the resource snapshot and track timestamps of data used from that resource, allowing for
	 * automated modification/timestamp handling.
	 * @param ResourceToUse
	 */
	use(ResourceToUse: typeof Resource, identifier: string | number) {
		const Used = this.useTable(ResourceToUse.tableName, ResourceToUse.schemaName);
		if (identifier == null) return Used;
		return new Used(identifier, this.request);
	}
	update(keyOrRecord) {
		throw new Error('Not implemented');
	}
	useTable(table_name: string, schema_name?: string): ResourceInterface {
		if (!tables) tables = getTables();
		const schema_object = schema_name ? tables[schema_name] : tables;
		const table_txn = this.inUseTables[table_name];
		if (table_txn) return table_txn;
		const table: Table = schema_object?.[table_name];
		if (!table) return;
		const key = schema_name ? schema_name + '/' + table_name : table_name;
		const env_path = table.envPath;
		const env_txn =
			this.transaction[env_path] ||
			(this.transaction[env_path] = new DatabaseTransaction(table.primaryStore, this.user, table.auditStore));
		return (
			this.inUseTables[key] ||
			(this.inUseTables[key] = table.transaction(this.request, env_txn, env_txn.getReadTxn(), this))
		);
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
	static async transact(callback) {
		if (this.transaction) return callback(this);
		const name = this.name + ' (txn)';
		const transaction = [];
		transaction._txnTime = getNextMonotonicTime();

		const txn_resource = class extends this {
			static name = name;
			static transaction = transaction;
			static inUseTables = {};
		};
		try {
			return await callback(txn_resource);
		} finally {
			await txn_resource.commit();
		}
	}
	transact(callback) {
		return callback(this);
	}
	async accessInTransaction(request, action: (resource_access) => any) {
		return this.transact(async (transactional_resource) => {
			const resource_access = transactional_resource.access(request);
			transactional_resource.result = await action(resource_access);
			return transactional_resource;
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
	static allowRead(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowRead(user): boolean | object {
		return this.constructor.allowRead(user);
	}
	static allowUpdate(): boolean | object {
		// can not update the entire table by default
		return false;
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
