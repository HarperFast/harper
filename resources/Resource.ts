import { ResourceInterface, Request, SubscriptionRequest, Id, Context, Query } from './ResourceInterface';
import { getTables } from './databases';
import { Table } from './Table';
import { randomUUID } from 'crypto';
import { DatabaseTransaction, Transaction } from './DatabaseTransaction';
import { DefaultAccess } from './Access';
import { IterableEventQueue } from './IterableEventQueue';
import { _assignPackageExport } from '../index';
import { parseQuery } from './search';
import { ClientError } from '../utility/errors/hdbError';
import { OWN_DATA } from './tracked';
import { transaction } from './transaction';

let tables;

export const CONTEXT = Symbol.for('context');
export const ID_PROPERTY = Symbol.for('id');
export const IS_COLLECTION = Symbol('is-collection');
export const SAVE_UPDATES_PROPERTY = Symbol('save-updates');
export const RECORD_PROPERTY = Symbol('stored-record');

/**
 * This is the main class that can be extended for any resource in HarperDB and provides the essential reusable
 * uniform interface for interacting with data, defining the API for providing data (data sources) and for consuming
 * data. This interface is used pervasively in HarperDB and is implemented by database tables and can be used to define
 * sources for caching, real-data sources for messaging protocols, and RESTful endpoints, as well as any other types of
 * data aggregation, processing, or monitoring.
 */
export class Resource implements ResourceInterface {
	[CONTEXT]: Context;
	[ID_PROPERTY]: any;
	static transactions: Transaction[] & { timestamp: number };
	constructor(identifier: Id, source: Context | { [CONTEXT]: Context }) {
		this[ID_PROPERTY] = identifier;
		const context = source[CONTEXT];
		this[CONTEXT] = context !== undefined ? context : source || null;
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
			// TODO: Handle async
			const result =
				is_collection && resource.search
					? resource.search(request)
					: request.property && request.hasOwnProperty('property')
					? resource.get?.(request.property)
					: resource.get?.();
			let select;
			if ((select = request.select) && request.hasOwnProperty('select') && result != null) {
				let transform = transformForSelect(request.select);
				if (is_collection) {
					return result.map(transform);
				} else {
					return transform(request.select)(result);
				}
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
			return resource.put ? resource.put(record) : missingMethod(resource, 'put');
		},
		{ hasContent: true, type: 'update' }
	);
	static delete(identifier: Id, context?: Context): Promise<boolean>;
	static delete(request: Request, context?: Context): Promise<object>;
	static delete = transactional(
		function (request: Request, resource: Resource) {
			return resource.delete ? resource.delete() : missingMethod(resource, 'delete');
		},
		{ hasContent: false, type: 'delete' }
	);

	static getNewId() {
		return randomUUID();
	}
	static async create(record: any, context: Context): Promise<Id> {
		const id = this.getNewId(); //uuid.v4();
		return transaction(context, (context) => {
			const resource = new this(id, context);
			const results = resource.put ? resource.put(record) : missingMethod(resource, 'put');
			if (context.responseMetadata) {
				context.responseMetadata.location = id;
				context.responseMetadata.created = true;
			}
			return results?.then ? results.then(() => id) : id;
		});
	}
	static post = transactional(
		async function (request: Request, resource: Resource) {
			const data = await request.data;
			if (resource[ID_PROPERTY] != null) resource.update(); // save any changes made during post
			return resource.post(data);
		},
		{ hasContent: true, type: 'create' }
	);

	static connect = transactional(
		function (request: Request, resource: Resource) {
			return resource.connect ? resource.connect(request) : missingMethod(resource, 'connect');
		},
		{ type: 'read' }
	);

	static subscribe(request: SubscriptionRequest): Promise<AsyncIterable<{ id: any; operation: string; value: object }>>;
	static subscribe = transactional(
		function (request: Request, resource: Resource) {
			return resource.subscribe ? resource.subscribe(request) : missingMethod(resource, 'subscribe');
		},
		{ type: 'read' }
	);

	static publish = transactional(
		async function (request: Request, resource: Resource) {
			const message = await request.data;
			if (resource[ID_PROPERTY] != null) resource.update(); // save any changes made during publish
			return resource.publish ? resource.publish(message) : missingMethod(resource, 'publish');
		},
		{ hasContent: true, type: 'create' }
	);

	static search = transactional(
		function (request: Request, resource: Resource) {
			return resource.search ? resource.search(request) : missingMethod(resource, 'search');
		},
		{ type: 'read' }
	);

	static query = transactional(
		async function (request: Request, resource: Resource) {
			const query = await request.data;
			return resource.search ? resource.search(query) : missingMethod(resource, 'search');
		},
		{ hasContent: true, type: 'read' }
	);
	static query = this.search;

	static copy = transactional(
		function (request: Request, resource: Resource) {
			return resource.copy ? resource.copy(request.headers?.destination) : missingMethod(resource, 'copy');
		},
		{ type: 'create' }
	);

	static move = transactional(
		function (request: Request, resource: Resource) {
			return resource.move ? resource.move(request.headers?.destination) : missingMethod(resource, 'move');
		},
		{ type: 'delete' }
	);

	post(new_record) {
		if (this[ID_PROPERTY] == null) return this.constructor.create(new_record, this[CONTEXT]);
		missingMethod(this, 'post');
	}

	static isCollection(resource) {
		return resource?.[IS_COLLECTION];
	}
	static coerceId(id: string): number | string {
		return id;
	}
	static getResource(id: Id, request: Request): Resource | Promise<Resource> {
		let resource;
		const is_collection = id == null || (id.constructor === Array && id[id.length - 1] == null);
		// if it is a collection and we have a collection class defined, use it
		const constructor = (is_collection && this.Collection) || this;
		let context = request[CONTEXT];
		if (!context) context = context === undefined ? request : {};
		if (context.transaction) {
			let resource_cache;
			if (context.resourceCache) {
				resource_cache = context.resourceCache;
			} else resource_cache = context.resourceCache = [];
			// we have two different cache formats, generally we want to use a simple array for small transactions, but can transition to a Map for larger operations
			if (resource_cache.asMap) {
				// we use the Map structure for larger transactions that require a larger cache (constant time lookups)
				let cache_for_id = resource_cache.asMap.get(id);
				resource = cache_for_id?.find((resource) => resource.constructor === constructor);
				if (resource) return resource;
				if (!cache_for_id) resource_cache.asMap.set(id, (cache_for_id = []));
				cache_for_id.push((resource = new constructor(id, context)));
			} else {
				// for small caches, this is probably fastest
				resource = resource_cache.find(
					(resource) => resource[ID_PROPERTY] === id && resource.constructor === constructor
				);
				if (resource) return resource;
				resource_cache.push((resource = new constructor(id, context)));
				if (resource_cache.length > 10) {
					// if it gets too big, upgrade to a Map
					const cache_map = new Map();
					for (const resource of resource_cache) {
						const id = resource[ID_PROPERTY];
						const cache_for_id = cache_map.get(id);
						if (cache_for_id) cache_for_id.push(resource);
						else cache_map.set(id, [resource]);
					}
					context.resourceCache.length = 0; // clear out all the entries since we are using the map now
					context.resourceCache.asMap = cache_map;
				}
			}
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
			// for put, post, patch, publish, query
			const data = request;
			if (context) {
				request = Object.create(CONTEXT in context ? context[CONTEXT] : context);
				id = context.hasOwnProperty('id') ? context.id : this.primaryKey && data?.[this.primaryKey];
			} else {
				request = {};
				if (this.primaryKey) id = data[this.primaryKey];
			}
			request.data = data;
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
			return resource.then ? resource.then(authorizeActionOnResource) : authorizeActionOnResource(resource);
		} else {
			// start a transaction
			return transaction(request, (request) => {
				const resource = this.getResource(id, request);
				return resource.then ? resource.then(authorizeActionOnResource) : authorizeActionOnResource(resource);
			});
		}
		function authorizeActionOnResource(resource: ResourceInterface) {
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
function missingMethod(resource, method) {
	const error = new ClientError(`The ${resource.constructor.name} does not have a ${method} method implemented`, 405);
	error.allow = [];
	error.method = method;
	for (const method of ['get', 'put', 'post', 'delete', 'query', 'move', 'copy']) {
		if (typeof resource[method] === 'function') error.allow.push(method);
	}
	throw error;
}
function selectFromObject(object) {
	// TODO: eventually we will do aggregate functions here
	const record = object[RECORD_PROPERTY];
	if (record) {
		const own_data = object[OWN_DATA];
		return (property) => {
			let value;
			if (object.hasOwnProperty(property) && typeof (value = object[property]) !== 'function') {
				return value;
			}
			if (own_data && property in own_data) {
				return own_data[property];
			} else return record[property];
		};
	} else return (property) => object[property];
}
function transformForSelect(select) {
	if (typeof select === 'string') // if select is a single string then return property value
		return (object) => {
			return selectFromObject(object)(select);
		};
	else if (typeof select === 'object') {
		// if it is an array, return an array
		if (Array.isArray(select)) {
			if (!select.asObject)
				return (object) => {
					const results = [];
					const getProperty = selectFromObject(object);
					for (const property of select) {
						results.push(getProperty(property));
					}
					return results;
				};
		} else {
			const select_array = [];
			for (const key in select) {
				select_array.push(key);
			}
			select = select_array;
		}
		const forceNulls = select.forceNulls;
		return (object) => { // finally the case of returning objects
			const selected_data = {};
			const getProperty = selectFromObject(object);
			for (const property of select) {
				let value = getProperty(property);
				if (value === undefined && forceNulls) value = null;
				selected_data[property] = value;
			}
			return selected_data;
		};
	}
}
