import { ResourceInterface, Request, SearchRequest, SubscriptionRequest, Id } from './ResourceInterface';
import { getTables } from './databases';
import { Table } from './Table';
import { randomUUID } from 'crypto';
import { DatabaseTransaction, Transaction } from './DatabaseTransaction';
import { DefaultAccess } from './Access';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { IterableEventQueue } from './IterableEventQueue';
import { _assignPackageExport } from '../index';
import { parseQuery } from './search';
import { ClientError } from '../utility/errors/hdbError';

let tables;

export const REQUEST = Symbol.for('request');
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
	request: Request;
	[USER_PROPERTY]: any;
	[ID_PROPERTY]: any;
	[LAST_MODIFICATION_PROPERTY] = 0;
	[TRANSACTIONS_PROPERTY]: Transaction[] & { timestamp: number };
	static transactions: Transaction[] & { timestamp: number };
	constructor(identifier: Id, request: Request) {
		this[ID_PROPERTY] = identifier;
		this.request = request;
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

	static async get(identifier: Id, request?: Request): Promise<object>;
	static async get(request: Request): Promise<object>;
	static async get(request: SearchRequest): Promise<AsyncIterable<object>>;
	static async get(id: Id, request: Request) {
		let path, search;
		if (id && typeof id === 'object' && !request) {
			({ id, path, search } = request = id);
		} else if (request) {
			// and id and request were provided, create a request with the provided id
			({ path, search } = request);
			request = Object.assign({}, request); // copy it so we don't modify the original
			request.id = id;
		} else {
			// only id provided
			request = { id };
		}
		if (search) request.query = parseQuery(search);
		const resource = await this.getResource(request);
		resource[SAVE_UPDATES_PROPERTY] = false; // by default modifications aren't saved, they just yield a different result from get
		if (request.authorize) {
			const allowed = await resource.allowRead(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
			request.authorize = false;
		}
		return resource.get(request);
	}
	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 */
	static async put(request) {
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowUpdate(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.put(request);
	}
	static async delete(request) {
		request.allowInvalidated = true;
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowDelete(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.delete(request);
	}

	put(record: object, options?): Promise<void>;
	static getNewId() {
		return randomUUID();
	}
	static async create(request: Request): Promise<Id> {
		const id = this.getNewId(); //uuid.v4();
		const resource = new this(id, request);
		await resource.put(request);
		return id;
	}
	static async post(request) {
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowCreate(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.post(request);
	}
	static async connect(request) {
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowRead(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.connect(request);
	}
	static async subscribe(request: Request): AsyncIterable<{ id: any; operation: string; value: object }> {
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowRead(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.subscribe(request);
	}
	static async publish(request: Request): Promise<void> {
		const resource = await this.getResource(request);
		if (request.authorize) {
			request.authorize = false;
			const allowed = await resource.allowCreate(request);
			if (!allowed) {
				throw new AccessError(request.user);
			}
		}
		return resource.publish(request);
	}

	post(new_record) {
		if (this[ID_PROPERTY] == null) return this.constructor.create(new_record);
		throw new Error('No post method defined for resource');
	}

	static search(query: object): AsyncIterable<object> {
		return new this(null).search(query);
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
	static getResource(request: Request): Resource | Promise<Resource> {
		let resource;
		let { path, id } = request;
		if (!path) {
			path = id?.toString() ?? '';
		}
		if (request.transaction) {
			let resource_cache;
			if (request.resourceCache) {
				resource_cache = request.resourceCache;
			} else resource_cache = request.resourceCache = new Map();
			resource = resource_cache.get(path);
			if (resource) return resource;
			resource_cache.set(path, (resource = new this(id, request)));
		} else resource = new this(id, request);
		if (id == null || (id.constructor === Array && id[id.length - 1] == null)) resource[IS_COLLECTION] = true;
		return resource;
	}

	/**
	 * This is called by protocols that wish to make a subscription for real-time notification/updates
	 * @param query
	 * @param options
	 */
	subscribe(options?: {}): AsyncIterable<{ id: any; operation: string; value: object }>;

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

	update(keyOrRecord) {
		throw new Error('Not implemented');
	}

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
Resource.prototype.request = null;
_assignPackageExport('Resource', Resource);

export function snake_case(camelCase: string) {
	return (
		camelCase[0].toLowerCase() +
		camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters.slice(1))
	);
}

class AccessError extends Error {
	constructor(user) {
		if (user) {
			super('Unauthorized access to resource');
			this.status = 403;
		} else {
			super('Must login');
			this.status = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
	}
}
