import { ResourceInterface, Request, SubscriptionRequest, Id, Context, Query } from './ResourceInterface';
import { randomUUID } from 'crypto';
import { Transaction } from './DatabaseTransaction';
import { IterableEventQueue } from './IterableEventQueue';
import { _assignPackageExport } from '../index';
import { ClientError } from '../utility/errors/hdbError';
import { OWN_DATA } from './tracked';
import { transaction } from './transaction';
import { parseQuery } from './search';

export const CONTEXT = Symbol.for('context');
export const ID_PROPERTY = Symbol.for('primary-key');
export const IS_COLLECTION = Symbol('is-collection');
export const RECORD_PROPERTY = Symbol('stored-record');

const EXTENSION_TYPES = {
	json: 'application/json',
	cbor: 'application/cbor',
	msgpack: 'application/x-msgpack',
	csv: 'text/csv',
};

/**
 * This is the main class that can be extended for any resource in HarperDB and provides the essential reusable
 * uniform interface for interacting with data, defining the API for providing data (data sources) and for consuming
 * data. This interface is used pervasively in HarperDB and is implemented by database tables and can be used to define
 * sources for caching, real-data sources for messaging protocols, and RESTful endpoints, as well as any other types of
 * data aggregation, processing, or monitoring.
 *
 * This base Resource class provides a set of static methods that are main entry points for querying and updating data
 * in resources/tables. The static methods provide the default handling of arguments, context, and ensuring that
 * internal actions are wrapped in a transaction. The base Resource class intended to be extended, and the instance
 * methods can be overriden to provide specific implementations of actions like get, put, post, delete, and subscribe.
 */
export class Resource implements ResourceInterface {
	static transactions: Transaction[] & { timestamp: number };
	constructor(identifier: Id, source: any) {
		this[ID_PROPERTY] = identifier;
		const context = source?.[CONTEXT];
		this[CONTEXT] = context !== undefined ? context : source || null;
	}

	/**
	 * The get methods are for directly getting a resource, and called for HTTP GET requests.
	 */
	static get(identifier: Id, context?: Context): Promise<object>;
	static get(request: Request, context?: Context): Promise<object>;
	static get(query: Query, context?: Context): Promise<AsyncIterable<object>>;
	static get = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			const result = resource.get?.(query);
			if (result?.then) return result.then(handleSelect);
			return handleSelect(result);
			function handleSelect(result) {
				let select;
				if ((select = query?.select) && result != null && !result.selectApplied) {
					const transform = transformForSelect(select, resource.constructor);
					if (typeof result?.map === 'function') {
						return result.map(transform);
					} else {
						return transform(result);
					}
				}
				return result;
			}
		},
		{
			type: 'read',
			// allows context to reset/remove transaction after completion so it can be used in immediate mode:
			resetTransaction: true,
			ensureLoaded: true, // load from source by default
			async: true, // use async by default
		}
	);
	get?(query?): Promise<any>;
	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 */
	static put = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			if (Array.isArray(data) && resource[IS_COLLECTION]) {
				const results = [];
				const authorize = request.authorize;
				for (const element of data) {
					const resource_class = resource.constructor;
					const element_resource = resource_class.getResource(element[resource_class.primaryKey], request, {
						async: true,
					});
					if (element_resource.then) results.push(element_resource.then((resource) => resource.put(element, request)));
					else results.push(element_resource.put(element, request));
				}
				return Promise.all(results);
			}
			return resource.put ? resource.put(data, query) : missingMethod(resource, 'put');
		},
		{ hasContent: true, type: 'update' }
	);

	static patch = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			// TODO: Allow array like put?
			return resource.patch ? resource.patch(data, query) : missingMethod(resource, 'patch');
		},
		{ hasContent: true, type: 'update' }
	);

	static delete(identifier: Id, context?: Context): Promise<boolean>;
	static delete(request: Request, context?: Context): Promise<object>;
	static delete = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.delete ? resource.delete(query) : missingMethod(resource, 'delete');
		},
		{ hasContent: false, type: 'delete' }
	);

	/**
	 * Generate a new primary key for a resource; by default we use UUIDs (for now).
	 */
	static getNewId() {
		return randomUUID();
	}
	static create(id_prefix: Id, record: any, context: Context): Promise<Id>;
	static create(record: any, context: Context): Promise<Id>;
	static create(id_prefix: any, record: any, context?: Context): Promise<Id> {
		let id;
		if (id_prefix == null) id = this.getNewId(); //uuid.v4();
		else if (Array.isArray(id_prefix) && typeof id_prefix[0] !== 'object') id = [...id_prefix, this.getNewId()];
		else if (typeof id_prefix !== 'object') id = [id_prefix, this.getNewId()];
		else {
			// two argument form, shift the arguments
			id = this.getNewId();
			context = record;
			record = id_prefix;
		}
		return transaction(context, () => {
			const resource = new this(id, context);
			const results = resource.update ? resource.update(record) : missingMethod(resource, 'update');
			context.newLocation = id;
			context.createdResource = true;
			return results?.then ? results.then(() => id) : id;
		});
	}
	static invalidate = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.invalidate ? resource.invalidate(query) : missingMethod(resource, 'delete');
		},
		{ hasContent: false, type: 'update' }
	);

	static post = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			if (resource[ID_PROPERTY] != null) resource.update?.(); // save any changes made during post
			return resource.post(data, query);
		},
		{ hasContent: true, type: 'create' }
	);

	static connect = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.connect ? resource.connect(data, query) : missingMethod(resource, 'connect');
		},
		{ hasContent: true, type: 'read' }
	);

	static subscribe(request: SubscriptionRequest): Promise<AsyncIterable<{ id: any; operation: string; value: object }>>;
	static subscribe = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.subscribe ? resource.subscribe(query) : missingMethod(resource, 'subscribe');
		},
		{ type: 'read' }
	);

	static publish = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			if (resource[ID_PROPERTY] != null) resource.update?.(); // save any changes made during publish
			return resource.publish ? resource.publish(data, query) : missingMethod(resource, 'publish');
		},
		{ hasContent: true, type: 'create' }
	);

	static search = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			const result = resource.search ? resource.search(query) : missingMethod(resource, 'search');
			const select = request.select;
			if (select && request.hasOwnProperty('select') && result != null && !result.selectApplied) {
				const transform = transformForSelect(select, resource.constructor);
				return result.map(transform);
			}
			return result;
		},
		{ type: 'read' }
	);

	static query = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.search ? resource.search(data, query) : missingMethod(resource, 'search');
		},
		{ hasContent: true, type: 'read' }
	);

	static copy = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.copy ? resource.copy(data, query) : missingMethod(resource, 'copy');
		},
		{ type: 'create' }
	);

	static move = transactional(
		function (resource: Resource, query?: Map, request: Request, data?: any) {
			return resource.move ? resource.move(data, query) : missingMethod(resource, 'move');
		},
		{ type: 'delete' }
	);

	post(new_record) {
		if (this[IS_COLLECTION]) return this.constructor.create(this[ID_PROPERTY], new_record, this[CONTEXT]);
		missingMethod(this, 'post');
	}

	static isCollection(resource) {
		return resource?.[IS_COLLECTION];
	}
	static coerceId(id: string): number | string {
		return id;
	}
	static parseQuery(search) {
		return parseQuery(search);
	}
	static parsePath(path, context, query) {
		const dot_index = path.indexOf('.');
		if (dot_index > -1) {
			const property = path.slice(dot_index + 1);
			path = path.slice(0, dot_index);
			const accept = context?.headers && EXTENSION_TYPES[property];
			if (accept) {
				// TODO: Might be preferable to pass this into getDeserializer instead of modifying the request itself
				context.headers.set('accept', accept);
			} else if (query) query.property = property;
			else {
				return {
					query: { property },
					id: pathToId(path, this),
					isCollection: id_was_collection,
				};
			}
		}
		// convert paths to arrays like /nested/path/4 -> ['nested', 'path', 4]
		const id = pathToId(path, this);
		if (id_was_collection) {
			return { id, isCollection: true };
		}
		return id;
	}
	/**
	 * Gets an instance of a resource by id
	 * @param id
	 * @param request
	 * @param options
	 * @returns
	 */
	static getResource(id: Id, request: Request, options?: any): Resource | Promise<Resource> {
		let resource;
		let context = request[CONTEXT];
		let is_collection;
		if (typeof request.isCollection === 'boolean' && request.hasOwnProperty('isCollection'))
			is_collection = request.isCollection;
		else is_collection = options?.isCollection;
		// if it is a collection and we have a collection class defined, use it
		const constructor = (is_collection && this.Collection) || this;
		if (!context) context = context === undefined ? request : {};
		if (context.transaction) {
			// if this is part of a transaction, we use a map of existing loaded instances
			// so that if a resource is already requested by id in this transaction, we can
			// reuse that instance and preserve and changes/updates in that instance.
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
		} else resource = new constructor(id, context); // outside of a transaction, just create an instance
		if (is_collection) resource[IS_COLLECTION] = true;
		return resource;
	}

	/**
	 * This is called by protocols that wish to make a subscription for real-time notification/updates.
	 * This default implementation simply provides a streaming iterator that does not deliver any notifications
	 * but implementors can call send with
	 * @param query
	 * @param options
	 */
	subscribe(options?: {}): AsyncIterable<{ id: any; operation: string; value: object }> {
		return new IterableEventQueue();
	}

	connect(query?: {}): AsyncIterable<any> {
		// convert subscription to an (async) iterator
		if (query?.subscribe !== false) {
			// subscribing is the default action, but can be turned off
			return this.subscribe?.(query);
		}
		return new IterableEventQueue();
	}

	// Default permissions (super user only accesss):
	allowRead(user): boolean | object {
		return user?.role.permission.super_user;
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
	/**
	 * Get the primary key value for this resource.
	 * @returns primary key
	 */
	getId() {
		return this[ID_PROPERTY];
	}
	/**
	 * Get the context for this resource
	 * @returns context object with information about the current transaction, user, and more
	 */
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
			this.statusCode = 403;
		} else {
			super('Must login');
			this.statusCode = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
	}
}
let id_was_collection;
function pathToId(path, Resource) {
	id_was_collection = false;
	if (path === '') return null;
	path = path.slice(1);
	if (path.indexOf('/') === -1) {
		if (path === '') {
			id_was_collection = true;
			return null;
		}
		// special syntax for more compact numeric representations
		if (path.startsWith('$')) path = parseInt(path, 36);
		return Resource.coerceId(decodeURIComponent(path));
	}
	const string_ids = path.split('/');
	const ids = new MulitPartId();
	for (let i = 0; i < string_ids.length; i++) {
		const id_part = string_ids[i];
		if (!id_part && i === string_ids.length - 1) {
			id_was_collection = true;
			break;
		}
		ids[i] = Resource.coerceId(decodeURIComponent(id_part));
	}
	return ids;
}
/**
 * An array for ids that toString's back to slash-delimited string
 */
class MulitPartId extends Array {
	toString() {
		return this.join('/');
	}
}
/**
 * This is responsible for arranging arguments in the main static methods and creating the appropriate context and default transaction wrapping
 * @param action
 * @param options
 * @returns
 */
function transactional(action, options) {
	applyContext.reliesOnPrototype = true;
	const has_content = options.hasContent;
	return applyContext;
	function applyContext(id_or_query: string | Id, data_or_context?: any, context?: Context) {
		let id, query, is_collection;
		let data;
		// First we do our argument normalization. There are two main types of methods, with or without content
		if (has_content) {
			// for put, post, patch, publish, query
			if (context) {
				// if there are three arguments, it is id, data, context
				data = data_or_context;
				context = context[CONTEXT] || context;
			} else if (data_or_context) {
				// two arguments, more possibilities:
				if (
					typeof id_or_query === 'object' &&
					id_or_query &&
					(!Array.isArray(id_or_query) || typeof id_or_query[0] === 'object')
				) {
					// (data, context) form
					data = id_or_query;
					id = data[this.primaryKey] ?? null;
					context = data_or_context[CONTEXT] || data_or_context;
				} else {
					// (id, data) form
					data = data_or_context;
				}
			} else {
				// single argument form, just data
				data = id_or_query;
				id = data[ID_PROPERTY] ?? data[this.primaryKey] ?? null;
			}
			if (id == null) is_collection = true;
			// otherwise handle methods for get, delete, etc.
			// first, check to see if it is two argument
		} else if (data_or_context) {
			// (id, context), preferred form used for methods without a body
			context = data_or_context[CONTEXT] || data_or_context;
		} else if (id_or_query && typeof id_or_query === 'object' && !Array.isArray(id_or_query)) {
			// (request) a structured id/query, which we will use as the context
			context = id_or_query;
		}
		if (id === undefined) {
			if (typeof id_or_query === 'string') {
				id = id_or_query;
			} else if (typeof id_or_query === 'object' && id_or_query) {
				// it is a query
				query = id_or_query;
				if (id_or_query[Symbol.iterator]) {
					// get the id part from an iterable query
					id = [];
					is_collection = true;
					for (const part of id_or_query) {
						if (typeof part === 'object' && part) break;
						id.push(part);
					}
					if (id.length === 0) id = null;
					else {
						if (id.length === 1) id = id[0];
						if (query.slice) {
							query = query.slice(id.length, query.length);
							if (query.length === 0) {
								query = null;
								is_collection = false;
							}
						}
					}
				} else {
					if (typeof (id = id_or_query.url) === 'string') {
						// handle queries in local URLs like /path/?name=value
						const search_index = id.indexOf('?');
						if (search_index > -1) {
							const parsed_query = this.parseQuery(id.slice(search_index + 1));
							if (query) query = Object.assign(parsed_query, query);
							else query = parsed_query;
							id = id.slice(0, search_index);
						}
						// handle paths of the form /path/id.property
						const parsed_id = this.parsePath(id, context, query);
						if (parsed_id?.id !== undefined) {
							if (parsed_id.query) {
								if (query) query = Object.assign(parsed_id.query, query);
								else query = parsed_id.query;
							}
							is_collection = parsed_id.isCollection;
							id = parsed_id.id;
						} else id = parsed_id;
					}
					if (id === undefined) {
						id = id_or_query.id ?? null;
						if (id == null) is_collection = true;
					}
				}
			} else {
				id = id_or_query ?? null;
				if (id == null) is_collection = true;
			}
		}

		if (!context) context = {};
		let resource_options;
		if (query?.ensureLoaded != null || query?.async || is_collection) {
			resource_options = Object.assign({}, options);
			if (query?.ensureLoaded != null) resource_options.ensureLoaded = query.ensureLoaded;
			if (query?.async) resource_options.async = query.async;
			if (is_collection) resource_options.isCollection = true;
		} else resource_options = options;
		if (context.transaction) {
			// we are already in a transaction, proceed
			const resource = this.getResource(id, context, resource_options);
			return resource.then ? resource.then(authorizeActionOnResource) : authorizeActionOnResource(resource);
		} else {
			resource_options.resetTransaction = true;
			// start a transaction
			return transaction(
				context,
				() => {
					const resource = this.getResource(id, context, resource_options);
					return resource.then ? resource.then(authorizeActionOnResource) : authorizeActionOnResource(resource);
				},
				resource_options
			);
		}
		function authorizeActionOnResource(resource: ResourceInterface) {
			if (context.authorize) {
				// do permission checks (and don't require subsequent uses of this request/context to need to do it)
				context.authorize = false;
				const allowed =
					options.type === 'read'
						? resource.allowRead(context.user, query, context)
						: options.type === 'update'
						? resource.doesExist?.() === false
							? resource.allowCreate(context.user, data, context)
							: resource.allowUpdate(context.user, data, context)
						: options.type === 'create'
						? resource.allowCreate(context.user, data, context)
						: resource.allowDelete(context.user, query, context);
				if (allowed?.then) {
					return allowed.then((allowed) => {
						if (!allowed) {
							throw new AccessError(context.user);
						}
						if (typeof data?.then === 'function') return data.then((data) => action(resource, query, context, data));
						return action(resource, query, context, data);
					});
				}
				if (!allowed) {
					throw new AccessError(context.user);
				}
			}
			if (typeof data?.then === 'function') return data.then((data) => action(resource, query, context, data));
			return action(resource, query, context, data);
		}
	}
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
/**
 * This is responsible for handling a select query parameter/call that selects specific
 * properties from the returned record(s).
 * @param object
 * @returns
 */
function selectFromObject(object, property_resolvers, context) {
	// TODO: eventually we will do aggregate functions here
	const record = object[RECORD_PROPERTY];
	if (record) {
		const own_data = object[OWN_DATA];
		return (property) => {
			let value, resolver;
			if (object.hasOwnProperty(property) && typeof (value = object[property]) !== 'function') {
				return value;
			}
			if (own_data && property in own_data) {
				return own_data[property];
			} else if ((resolver = property_resolvers?.[property])) {
				return resolver(object, context);
			} else return record[property];
		};
	} else if (property_resolvers) {
		return (property) => {
			const resolver = property_resolvers[property];
			return resolver ? resolver(object, context) : object[property];
		};
	} else return (property) => object[property];
}
export function transformForSelect(select, resource) {
	const property_resolvers = resource?.propertyResolvers;
	const context = resource[CONTEXT];
	let sub_transforms;
	if (typeof select === 'string')
		// if select is a single string then return property value
		return function transform(object) {
			if (object.then) return object.then(transform);
			if (Array.isArray(object)) return object.map(transform);
			return selectFromObject(object, property_resolvers, context)(select);
		};
	else if (typeof select === 'object') {
		// if it is an array, return an array
		if (select.asArray)
			return function transform(object) {
				if (object.then) return object.then(transform);
				if (Array.isArray(object)) return object.map(transform);
				const results = [];
				const getProperty = handleProperty(selectFromObject(object, property_resolvers, context));
				for (const property of select) {
					results.push(getProperty(property));
				}
				return results;
			};
		const force_nulls = select.forceNulls;
		return function transform(object) {
			if (object.then) return object.then(transform);
			if (Array.isArray(object))
				return object.map((value) => (value && typeof value === 'object' ? transform(value) : value));
			// finally the case of returning objects
			const selected_data = {};
			const getProperty = handleProperty(selectFromObject(object, property_resolvers, context));
			let promises;
			for (const property of select) {
				let value = getProperty(property);
				if (value === undefined && force_nulls) value = null;
				if (value?.then) {
					if (!promises) promises = [];
					promises.push(value.then((value) => (selected_data[property.name || property] = value)));
				} else selected_data[property.name || property] = value;
			}
			if (promises) return Promise.all(promises).then(() => selected_data);
			return selected_data;
		};
	} else throw new Error('Invalid select argument type ' + typeof select);
	function handleProperty(getProperty) {
		return (property) => {
			if (typeof property === 'string') {
				return getProperty(property);
			} else if (typeof property === 'object') {
				// TODO: Handle aggregate functions
				if (property.name) {
					if (!sub_transforms) sub_transforms = {};
					// TODO: Get the resource, cache this transform, and apply above
					let transform = sub_transforms[property.name];
					if (!transform) {
						const resource = property_resolvers[property.name]?.definition?.tableClass;
						transform = sub_transforms[property.name] = transformForSelect(property.select || property, resource);
					}
					const value = getProperty(property.name);
					return transform(value);
				} else return getProperty(property);
			} else return property;
		};
	}
}
