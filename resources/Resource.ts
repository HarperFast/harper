import {
	ResourceInterface,
	Request,
	SearchRequest,
	SubscriptionRequest,
	Id,
	Context,
	Query,
	CollectionQuery,
} from './ResourceInterface';
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
import { OWN_DATA } from './tracked';
import { transaction } from './transaction';

let tables;

export const CONTEXT = Symbol.for('context');
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
	[CONTEXT]: Context;
	[USER_PROPERTY]: any;
	[ID_PROPERTY]: any;
	[LAST_MODIFICATION_PROPERTY] = 0;
	[TRANSACTIONS_PROPERTY]: Transaction[] & { timestamp: number };
	static transactions: Transaction[] & { timestamp: number };
	constructor(identifier: Id, context: Context) {
		this[ID_PROPERTY] = identifier;
		this[CONTEXT] = context ?? null;
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

	static get(identifier: Id, context?: Context): Promise<object>;
	static get(request: Request, context?: Context): Promise<object>;
	static get(query: Query, context?: Context): Promise<AsyncIterable<object>>;
	static get = transactional(
		function (request: Request, resource: Resource) {
			const is_collection = resource[IS_COLLECTION];
			const result = is_collection && resource.search ? resource.search(request) : resource.get();
			if (request.hasOwnProperty('select') && !is_collection && result) {
				const selected_data = {};
				const forceNulls = request.select.forceNulls;
				const own_data = result[OWN_DATA];
				for (const property of request.select) {
					let value;
					if (result.hasOwnProperty(property) && typeof (value = result[property]) !== 'function') {
						selected_data[property] = value;
						continue;
					}
					if (own_data && property in own_data) {
						const value = own_data[property];
						selected_data[property] = value;
					} else value = result[RECORD_PROPERTY][property];
					if (value === undefined && forceNulls) value = null;
					selected_data[property] = value;
				}
				return selected_data;
			}
			return result;
		},
		{ type: 'read' }
	);
	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 */
	static put = transactional(
		async function (request: Request, resource: Resource) {
			const record = await request.data;
			if (Array.isArray(record) && resource[IS_COLLECTION]) {
				const results = [];
				const authorize = request.authorize;
				for (const element of record) {
					if (authorize) request.authorize = true; // authorize each record
					results.push(this.put(element, request));
				}
				return results;
			}
			return resource.put(record);
		},
		{ hasContent: true, type: 'update' }
	);
	static delete = transactional(
		function (request: Request, resource: Resource) {
			return resource.delete(request);
		},
		{ hasContent: true, type: 'delete' }
	);

	static getNewId() {
		return randomUUID();
	}
	static async create(record: any, context: Context): Promise<Id> {
		const id = this.getNewId(); //uuid.v4();
		return transaction(context, (context) => {
			const resource = new this(id, context);
			resource.update(record);
			if (context.responseMetadata) {
				context.responseMetadata.location = id;
				context.responseMetadata.created = true;
			}
			return id;
		});
	}
	static post = transactional(
		async function (request: Request, resource: Resource) {
			const data = await request.data;
			return resource.post(data);
		},
		{ hasContent: true, type: 'create' }
	);

	static connect = transactional(
		function (request: Request, resource: Resource) {
			return resource.connect(request);
		},
		{ type: 'read' }
	);

	static subscribe(request: SubscriptionRequest): Promise<AsyncIterable<{ id: any; operation: string; value: object }>>;
	static subscribe = transactional(
		function (request: Request, resource: Resource) {
			return resource.subscribe(request);
		},
		{ type: 'read' }
	);

	static publish = transactional(
		async function (request: Request, resource: Resource) {
			const message = await request.data;
			return resource.publish(message);
		},
		{ hasContent: true, type: 'create' }
	);

	static search = transactional(
		function (request: Request, resource: Resource) {
			return resource.search(request);
		},
		{ type: 'read' }
	);

	post(new_record) {
		if (this[ID_PROPERTY] == null) return this.constructor.create(new_record, this[CONTEXT]);
		throw new Error('No post method defined for resource');
	}

	static isCollection(resource) {
		return resource?.[IS_COLLECTION];
	}
	static coerceId(id: string): number | string {
		return id;
	}
	static getResource(id: Id, request: Request): Resource | Promise<Resource> {
		let resource;
		let { path } = request;
		if (!path) {
			path = id?.toString() ?? '';
		}
		const is_collection = id == null || (id.constructor === Array && id[id.length - 1] == null);
		// if it is a collection and we have a collection class defined, use it
		const constructor = (is_collection && this.Collection) || this;
		const context = request[CONTEXT] || request;
		if (context.transaction) {
			let resource_cache;
			if (context.resourceCache) {
				resource_cache = context.resourceCache;
			} else resource_cache = context.resourceCache = new Map();
			resource = resource_cache.get(path);
			if (resource) return resource;
			resource_cache.set(path, (resource = new constructor(id, context)));
		} else resource = new constructor(id, context);
		if (is_collection) resource[IS_COLLECTION] = true;
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
	allowRead(user): boolean | object {
		return this.constructor.allowRead(user, query);
	}
	allowUpdate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowCreate(user): boolean | object {
		return user?.role.permission.super_user;
	}
	allowDelete(user): boolean | object {
		return user?.role.permission.super_user;
	}
	getContext() {
		return this[CONTEXT];
	}
}
Resource.prototype[CONTEXT] = null;
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
function transactional(action, options) {
	return function (request: Request | Id, context?: Context) {
		let id;
		if (options.hasContent) {
			// for put, post, patch
			if (context) {
				const data = request;
				request = Object.create(context);
				request.data = data;
			}
			id = request.hasOwnProperty('id') ? request.id : this.primaryKey && request.data[this.primaryKey];
			// otherwise check to see if the first arg is an id
		} else if (request && typeof request === 'object' && !Array.isArray(request)) {
			// request is actually a Request object, just make sure we inherit any context
			if (context) {
				context = CONTEXT in context ? context[CONTEXT] : context;
				request.transaction = context.transaction;
				request.user = context.user;
				request.resourceCache = context.resourceCache;
				request.timestamp = context.timestamp;
			}
			id = request.id;
		} else {
			// request is an id
			id = request;
			request = context ? Object.create(CONTEXT in context ? context[CONTEXT] : context) : {};
		}
		if (options.allowInvalidated) request.allowInvalidated = true;
		if (request.transaction) {
			// we are already in a transaction, proceed
			const resource = this.getResource(id, request);
			return resource.then ? resource.then(withResource) : withResource(resource);
		} else {
			// start a transaction
			return transaction(request, (request) => {
				const resource = this.getResource(id, request);
				return resource.then ? resource.then(withResource) : withResource(resource);
			});
		}
		function withResource(resource: ResourceInterface) {
			if (options.type === 'read') resource[SAVE_UPDATES_PROPERTY] = false; // by default modifications aren't saved, they just yield a different result from get
			if (request.authorize) {
				// do permission checks (and don't require subsequent uses of this request/context to need to do it)
				request.authorize = false;
				const allowed =
					options.type === 'read'
						? resource.allowRead(request.user, request)
						: options.type === 'update'
						? resource.doesExist?.() === false
							? resource.allowCreate(request.user, request)
							: resource.allowUpdate(request.user, request)
						: options.type === 'create'
						? resource.allowCreate(request.user, request)
						: resource.allowDelete(request.user, request);
				if (allowed?.then) {
					return allowed.then((allowed) => {
						if (!allowed) {
							throw new AccessError(request.user);
						}
						return action(request, resource);
					});
				}
				if (!allowed) {
					throw new AccessError(request.user);
				}
			}
			return action(request, resource);
		}
	};
}
function requestForDataArgs(record: any, context: Context): Request;
function requestForDataArgs(request: Request): Request;
function requestForDataArgs(request: Request | any, context?: Context) {
	if (context) {
		const data = request;
		request = Object.create(context);
		request.data = data;
	}
	return request;
}
