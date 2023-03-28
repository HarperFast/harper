import { ResourceInterface } from './ResourceInterface';
import { getTables } from './tableLoader';
import { Table } from './Table';
import { DatabaseTransaction } from './DatabaseTransaction';
import { DefaultAccess } from './Access';

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
	inUseEnvs = {};
	constructor(identifier?, request?) {
		this.id = identifier;
		this.request = request;
		this.user = request?.user;
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
	commit(flush = true): Promise<{ txnTxn: number }[]> {
		const commits = [];
		for (const env_path in this.inUseEnvs) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.inUseEnvs[env_path];
			// TODO: If we have multiple commits in a single resource instance, need to maintain
			// databases with waiting flushes to resolve at the end when a flush is requested.
			commits.push(env_txn.commit(flush));
		}
		return Promise.all(commits);
	}
	static commit = Resource.prototype.commit;
	abort() {
		for (const env_path in this.inUseEnvs) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.inUseEnvs[env_path];
			env_txn.abort(); // done with the read snapshot txn
		}
	}
	doneReading() {
		for (const env_path in this.inUseEnvs) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.inUseEnvs[env_path];
			env_txn.doneReading(); // done with the read snapshot txn
		}
	}
	static async get(identifier: string | number) {
		if (identifier) {
			return (await this.getResource(identifier, this.request)).get();
		}
		throw new Error('Not implemented');
	}
	loadDBRecord() {
		// nothing to be done by default, Table implements this
	}

	static async getResource(path, request) {
		let resource;
		if (typeof path === 'string') {
			const slash_index = path.indexOf?.('/');
			if (slash_index > -1) {
				resource = new this(decodeURIComponent(path.slice(0, slash_index)), request);
				resource.property = decodeURIComponent(path.slice(slash_index + 1));
			} else {
				resource = new this(decodeURIComponent(path), request);
			}
		} else resource = new this(path, request);
		await resource.loadDBRecord();
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
			this.inUseEnvs[env_path] ||
			(this.inUseEnvs[env_path] = new DatabaseTransaction(table.primaryStore, this.user, table.auditStore));
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
	static startTransaction(request) {
		return class extends this {
			static name = this.name + ' (txn)';
			static inUseEnvs = {};
			static inUseTables = {};
		};
	}
	startTransaction(request) {
		return this;
	}
	async accessInTransaction(request, action: (resource_access) => any) {
		const txn = this.startTransaction(request);
		let response_data;
		try {
			const resource_access = txn.access(request);
			txn.result = await action(resource_access);
		} finally {
			await txn.commit();
		}
		return txn;
	}
	static accessInTransaction = Resource.prototype.accessInTransaction;
	static access(request) {
		return new this.Access(request, this);
	}
	access(request) {
		return new this.constructor.Access(request, this);
	}
	static Access = DefaultAccess;
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
