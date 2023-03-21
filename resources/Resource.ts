import { ResourceInterface } from './ResourceInterface';
import { getTables } from './tableLoader';
import { Table } from './Table';
import { DatabaseTransaction } from './DatabaseTransaction';
let tables;
const QUERY_PARSER = /([^&|=<>!(),]+)([&|=<>!(),]*)/g;
const SYMBOL_OPERATORS = {
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
};

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
	 * Commit the transaction. This can involve several things based on what type of transaction:
	 * Separate read and read write isolation: Finish the batch, end read transaction
	 * Restartable/optimistic with full isolation: Acquire lock/ownership, complete transaction with optimistic checks, possibly return restart-required
	 * Non-restartable across multiple env/dbs with full isolation: Wait on commit of async-transaction
	 */
	commit(): Promise<boolean> {
		const txns_with_read_and_writes = [];
		const txns_with_only_writes = [];
		const commits = [];
		for (const env_path in this.inUseEnvs) {
			// TODO: maintain this array ourselves so we don't need to key-ify
			const env_txn = this.inUseEnvs[env_path];
			if (env_txn.writes.length > 0 || env_txn.updatingRecords?.length > 0) {
				if (env_txn.conditions.length > 0) txns_with_read_and_writes.push(env_txn);
				// I don't know if these will even be possible, might want to just eliminate this
				else txns_with_only_writes.push(env_txn);
			}
		}
		/*if (txns_with_read_and_writes.length >= 2) {
			// if multiple read+write txns are needed, we switch to a two phase commit approach and first do a request phase
			for (let env_txn of txns_with_read_and_writes) {
				commits.push(env_txn.requestCommit());
			}
			if ((await Promise.all(commits)).indexOf(false) > -1) {
				for (let env_txn of txns_with_read_and_writes) env_txn.abort();
				return false;
			}
			// all requests succeeded, proceed with collecting actual commits
			commits = [];
		}*/
		for (const env_txn of txns_with_read_and_writes) {
			commits.push(env_txn.commit());
		}
		/*if (commits.length === 1) { // no two phase commit, so just verify that the single commit succeeds before proceeding
			if (!await commits[0])
				return false;
			commits = [];
		}*/
		for (const env_txn of txns_with_only_writes) {
			commits.push(env_txn.commit());
		}
		return Promise.all(commits);
	}
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
	static async get(identifier: string | number, options?: any) {
		const resource = this.instantiate(identifier, options);
		let user;
		let data;
		if (options) {
			user = options.user;
			const checked = checkAllowed(resource.allowRead?.(user), user, resource);
			if (checked?.then) await checked; // fast path to avoid await if not needed
		}
		if (options.search)
			return {
				data: resource.search(this.parseQuery(options.search), options),
			};
		data = await resource.get();
		if (resource.property) {
			data = data[resource.property];
		}
		// TODO: commit or indicate stop reading
		return {
			updated: resource.lastModificationTime,
			data,
		};
	}
	static async head(identifier: string | number, request?: any) {
		const result = await this.get(identifier, request);
		return {
			updated: result.updated,
			// no data, that is the point of a HEAD request
		};
	}
	static async options(identifier: string | number, request?: any) {
		return {
			// mainly used for CORS
		};
	}

	static instantiate(identifier, request) {
		if (identifier == null && this.Collection) return new this.Collection(request);
		let resource;
		if (typeof identifier === 'string') {
			const slash_index = identifier.indexOf?.('/');
			if (slash_index > -1) {
				resource = new this(decodeURIComponent(identifier.slice(0, slash_index)), request);
				resource.property = decodeURIComponent(identifier.slice(slash_index + 1));
			} else {
				resource = new this(decodeURIComponent(identifier), request);
			}
		} else resource = new this(identifier, request);
		return resource;
	}

	static async put(identifier: string | number, request?: any) {
		const resource = this.instantiate(identifier, request);
		const user = request.user;
		const checked = checkAllowed(resource.allowPut?.(user), user, resource);
		if (checked?.then) await checked; // fast path to avoid await if not needed
		const updated_data = await request.data;
		resource.put(updated_data);
		const txn = await resource.commit();
		return {
			updated: txn[0].txnTime,
			data: updated_data,
		};
	}
	static async patch(identifier: string | number, request?: any) {
		const resource = this.instantiate(identifier, request);
		const user = request.user;
		const checked = checkAllowed(resource.allowPatch?.(user), user, resource);
		const updates = await request.data;
		const record = await resource.update();
		for (const key in updates) {
			record[key] = updates[key];
		}
		await resource.commit();
	}
	static async delete(identifier: string | number, request?: any) {
		const resource = this.instantiate(identifier, request);
		const user = request.user;
		const checked = checkAllowed(resource.allowDelete?.(user), user, resource);
		await resource.delete();
		await resource.commit();
	}
	static async post(identifier: string | number, request?: any) {
		const resource = this.instantiate(identifier, request);
		const user = request.user;
		const checked = checkAllowed(resource.allowPost?.(user), user, resource);
		const new_object = await request.data;
		await resource.create(identifier);
		await resource.commit();
	}

	static async publish(identifier: string | number, request?: any) {
		const resource = this.instantiate(identifier, request);
		const user = request.user;
		const checked = checkAllowed(resource.allowPublish?.(user), user, resource);
		const data = await request.data;
		if (request.retain) {
			// retain flag means we persist this message (for any future subscription starts), so treat it as the record itself
			if (data === undefined) await resource.delete(identifier);
			else await resource.put(data);
		} else await resource.publish(data);
		await resource.commit();
		return true;
	}

	/**
	 * This is responsible for taking a query string (from a get()) and converting it to a standard query object
	 * structure
	 * @param query_string
	 */
	static parseQuery(query_string: string) {
		let match;
		let attribute, comparison;
		const conditions = [];
		// TODO: Use URLSearchParams with a fallback for when it can't parse everything (USP is very fast)
		while ((match = QUERY_PARSER.exec(query_string))) {
			let [, value, operator] = match;
			switch (operator[0]) {
				case ')':
					// finish call
					operator = operator.slice(1);
					break;
				case '=':
					if (attribute) {
						// a FIQL operator like =gt=
						comparison = value;
					} else {
						comparison = 'equals';
						attribute = decodeURIComponent(value);
					}
					break;
				case '!':
				// TODO: not-equal
				case '<':
				case '>':
					comparison = SYMBOL_OPERATORS[operator];
					attribute = decodeURIComponent(value);
					break;

				case '':
				case '&':
				case '|':
					if (attribute) {
						conditions.push({
							type: comparison,
							attribute,
							value: decodeURIComponent(value),
						});
					}
					attribute = undefined;
			}
		}
		return conditions;
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
