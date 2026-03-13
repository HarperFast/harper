import type { User } from '../security/user.ts';
import type { RecordObject } from './RecordEncoder.js';
import {
	ResourceInterface,
	SubscriptionRequest,
	Id,
	Context,
	Query,
	SourceContext,
	RequestTargetOrId,
} from './ResourceInterface.ts';
import { randomUUID } from 'crypto';
import { DatabaseTransaction, type Transaction } from './DatabaseTransaction.ts';
import { IterableEventQueue } from './IterableEventQueue.ts';
import { _assignPackageExport } from '../globals.js';
import { ClientError, AccessViolation } from '../utility/errors/hdbError.js';
import { transaction, contextStorage } from './transaction.ts';
import { parseQuery } from './search.ts';
import { RequestTarget } from './RequestTarget.ts';
import { when, promiseNormalize } from '../utility/when.ts';

const EXTENSION_TYPES = {
	json: 'application/json',
	cbor: 'application/cbor',
	msgpack: 'application/x-msgpack',
	csv: 'text/csv',
};

/**
 * This is the main class that can be extended for any resource in Harper and provides the essential reusable
 * uniform interface for interacting with data, defining the API for providing data (data sources) and for consuming
 * data. This interface is used pervasively in Harper and is implemented by database tables and can be used to define
 * sources for caching, real-data sources for messaging protocols, and RESTful endpoints, as well as any other types of
 * data aggregation, processing, or monitoring.
 *
 * This base Resource class provides a set of static methods that are main entry points for querying and updating data
 * in resources/tables. The static methods provide the default handling of arguments, context, and ensuring that
 * internal actions are wrapped in a transaction. The base Resource class intended to be extended, and the instance
 * methods can be overridden to provide specific implementations of actions like get, put, post, delete, and subscribe.
 */
export class Resource<Record extends object = any> implements ResourceInterface<Record> {
	readonly #id: Id;
	readonly #context: Context | SourceContext;
	#isCollection: boolean;
	static transactions: Transaction[] & { timestamp: number };
	static directURLMapping = false;
	static loadAsInstance: boolean;
	constructor(identifier: Id, source: any) {
		this.#id = identifier;
		const context = source?.getContext ? (source.getContext() ?? null) : undefined;
		this.#context = context !== undefined ? context : source || null;
	}

	/**
	 * The get methods are for directly getting a resource, and called for HTTP GET requests.
	 */
	static get = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, _data: any) {
			const result = resource.get?.(query);
			// for the new API we always apply select in the instance method
			if (!resource.constructor.loadAsInstance) return result;
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
			letItLinger: true,
			ensureLoaded: true, // load from source by default
			hasContent: false,
			async: true, // use async by default
			method: 'get',
		}
	);

	/**
	 * Store the provided record by the provided id. If no id is provided, it is auto-generated.
	 */
	static put = transactional(
		function (resource: Resource, query: RequestTarget, request: Context, data: any) {
			if (Array.isArray(data) && resource.#isCollection && resource.constructor.loadAsInstance !== false) {
				const results = [];
				for (const element of data) {
					const resourceClass = resource.constructor;
					const id = element[resourceClass.primaryKey];
					let target = new RequestTarget();
					target.id = id;
					const elementResource = resourceClass.getResource(target, request, {
						async: true,
					});
					if (elementResource.then) results.push(elementResource.then((resource) => resource.put(element, request)));
					else results.push(elementResource.put(element, query));
				}
				return Promise.all(results);
			}
			return resource.put
				? resource.constructor.loadAsInstance === false
					? resource.put(query, data)
					: resource.put(data, query)
				: missingMethod(resource, 'put');
		},
		{ hasContent: true, type: 'update', method: 'put' }
	);

	static patch = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, data: any) {
			// TODO: Allow array like put?
			return resource.patch
				? resource.constructor.loadAsInstance === false
					? resource.patch(query, data)
					: resource.patch(data, query)
				: missingMethod(resource, 'patch');
		},
		{ hasContent: true, type: 'update', method: 'patch' }
	);

	static delete = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, _data: any) {
			return resource.delete ? resource.delete(query) : missingMethod(resource, 'delete');
		},
		{ hasContent: false, type: 'delete', method: 'delete' }
	);

	/**
	 * Generate a new primary key for a resource; by default we use UUIDs (for now).
	 */
	static getNewId() {
		return randomUUID();
	}

	/**
	 * Create a new resource with the provided record and id. If no id is provided, it is auto-generated. Note that this
	 * facilitates creating a new resource, but does not guarantee that this is not overwriting an existing entry.
	 * @param idPrefix
	 * @param record
	 * @param context
	 */
	static create(idPrefix: Id, record: any, context: Context): Promise<Id>;
	static create(record: any, context: Context): Promise<Id>;
	static create(idPrefix: any, record: any, context?: Context): Promise<Id> {
		let id: Id;
		if (this.loadAsInstance === false) {
			if (typeof idPrefix === 'object' && idPrefix && !context) {
				// two argument form (record, context), shift the arguments
				context = record;
				record = idPrefix;
				id = new RequestTarget();
				id.isCollection = true;
			} else id = idPrefix;
		} else {
			if (idPrefix == null) id = record?.[this.primaryKey] ?? this.getNewId();
			else if (Array.isArray(idPrefix) && typeof idPrefix[0] !== 'object')
				id = record?.[this.primaryKey] ?? [...idPrefix, this.getNewId()];
			else if (typeof idPrefix !== 'object') id = record?.[this.primaryKey] ?? [idPrefix, this.getNewId()];
			else {
				// two argument form, shift the arguments
				id = idPrefix?.[this.primaryKey] ?? this.getNewId();
				context = record || {};
				record = idPrefix;
			}
		}
		if (context) {
			if (context.getContext) context = context.getContext();
		} else {
			// try to get the context from the async context if possible
			context = contextStorage.getStore() ?? {};
		}
		return transaction(context, async () => {
			context.transaction.startedFrom ??= {
				resourceName: this.name,
				method: 'create',
			};
			const resource = new this(id, context);
			const results = resource.create ? await resource.create(id, record) : missingMethod(resource, 'create');
			context.newLocation = id ?? results?.[this.primaryKey];
			context.createdResource = true;
			return this.loadAsInstance === false ? results : resource;
		});
	}
	static invalidate = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, _data: any) {
			return resource.invalidate ? resource.invalidate(query) : missingMethod(resource, 'invalidate');
		},
		{ hasContent: false, type: 'update', method: 'invalidate' }
	);

	static post = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, data: any) {
			if (resource.#id != null) resource.update?.(); // save any changes made during post
			return resource.constructor.loadAsInstance === false ? resource.post(query, data) : resource.post(data, query);
		},
		{ hasContent: true, type: 'create', method: 'post' }
	);

	static update = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, data: any) {
			return resource.update(query, data);
		},
		{ type: 'update', method: 'update' }
	);

	static connect = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, data: any) {
			return resource.connect
				? resource.constructor.loadAsInstance === false
					? resource.connect(query, data)
					: resource.connect(data, query)
				: missingMethod(resource, 'connect');
		},
		{ hasContent: true, type: 'read', method: 'connect' }
	);

	static subscribe = transactional(
		function (resource: Resource, query: RequestTarget, _request: Context, _data: any) {
			return resource.subscribe ? resource.subscribe(query) : missingMethod(resource, 'subscribe');
		},
		{ type: 'read', method: 'subscribe', syncAllowed: true }
	);

	static publish = transactional(
		function (resource: Resource, query: Map, _request: Context, data: any) {
			if (resource.#id != null) resource.update?.(); // save any changes made during publish
			return resource.publish
				? resource.constructor.loadAsInstance === false
					? resource.publish(query, data)
					: resource.publish(data, query)
				: missingMethod(resource, 'publish');
		},
		{ hasContent: true, type: 'create', method: 'publish' }
	);

	static search = transactional(
		function (resource: Resource, query: Query, request: Context) {
			const result = resource.search ? resource.search(query) : missingMethod(resource, 'search');
			const select = request.select;
			if (select && request.hasOwnProperty('select') && result != null && !result.selectApplied) {
				const transform = transformForSelect(select, resource.constructor);
				return result.map(transform);
			}
			return result;
		},
		{ type: 'read', method: 'search', hasContent: false, syncAllowed: true }
	);

	static query = transactional(
		function (resource: Resource, query: Map, _request: Context, data: any) {
			return resource.search
				? resource.constructor.loadAsInstance === false
					? resource.search(query, data)
					: resource.search(data, query)
				: missingMethod(resource, 'search');
		},
		{ hasContent: true, type: 'read', method: 'query' }
	);

	static copy = transactional(
		function (resource: Resource, query: Map, _request: Context, data: any) {
			return resource.copy
				? resource.constructor.loadAsInstance === false
					? resource.copy(query, data)
					: resource.copy(data, query)
				: missingMethod(resource, 'copy');
		},
		{ hasContent: true, type: 'create', method: 'copy' }
	);

	static move = transactional(
		function (resource: Resource, query: Map, _request: Context, data: any) {
			return resource.move
				? resource.constructor.loadAsInstance === false
					? resource.move(query, data)
					: resource.move(data, query)
				: missingMethod(resource, 'move');
		},
		{ hasContent: true, type: 'delete', method: 'move' }
	);

	async post(
		target: RequestTargetOrId,
		newRecord: Partial<Record & RecordObject>
	): Promise<Record & Partial<RecordObject>> {
		if (this.constructor.loadAsInstance === false) {
			if (target.isCollection && this.create) {
				newRecord = await this.create(target, newRecord);
				return newRecord?.[this.constructor.primaryKey];
			}
		} else {
			if (this.#isCollection) {
				const resource = await this.constructor.create(this.#id, target, this.#context);
				return resource.#id;
			}
		}
		missingMethod(this, 'post');
	}

	static isCollection(resource) {
		return resource && resource.#isCollection;
	}
	get isCollection() {
		return this.#isCollection;
	}
	static coerceId(id: string): number | string {
		return id;
	}
	static parseQuery(search, query) {
		return parseQuery(search, query);
	}
	static parsePath(path, context, query) {
		const dotIndex = path.indexOf('.');
		if (dotIndex > -1) {
			// handle paths of the form /path/id.property
			const property = path.slice(dotIndex + 1);
			const requestedContentType = context?.headers && EXTENSION_TYPES[property];
			if (requestedContentType) {
				// handle path.json, path.cbor, etc. for requesting a specific content type using just the URL
				context.requestedContentType = requestedContentType;
				path = path.slice(0, dotIndex); // remove the property from the path
			} else if (this.attributes?.find((attribute) => attribute.name === property)) {
				// handle path.attribute for requesting a specific attribute using just the URL
				path = path.slice(0, dotIndex); // remove the property from the path
				if (query) query.property = property;
				else {
					return {
						property,
						id: path,
					};
				}
			}
		}
		return path;
	}
	/**
	 * Gets an instance of a resource by id
	 * @param id
	 * @param request
	 * @param options
	 * @returns
	 */
	static getResource(
		target: RequestTarget,
		request: Context | SourceContext,
		options?: any
	): Resource | Promise<Resource> {
		let resource;
		const id = target.id;
		let context = request.getContext?.();
		let isCollection;
		if (typeof request.isCollection === 'boolean' && request.hasOwnProperty('isCollection'))
			isCollection = request.isCollection;
		else isCollection = options?.isCollection;
		// if it is a collection and we have a collection class defined, use it
		const constructor = (isCollection && this.Collection) || this;
		if (!context) context = context === undefined ? request : {};
		resource = new constructor(id, context); // outside of a transaction, just create an instance
		if (isCollection) resource.#isCollection = true;
		return resource;
	}

	/**
	 * This is called by protocols that wish to make a subscription for real-time notification/updates.
	 * This default implementation simply provides a streaming iterator that does not deliver any notifications
	 * but implementors can call send with
	 */
	// eslint-disable-next-line no-unused-vars
	subscribe(request: SubscriptionRequest): AsyncIterable<Record> {
		return new IterableEventQueue();
	}

	connect(target: RequestTarget, incomingMessages: IterableEventQueue<Record>): AsyncIterable<Record> {
		// convert subscription to an (async) iterator
		const query = this.constructor.loadAsInstance === false ? target : incomingMessages;
		if (query?.subscribe !== false) {
			// subscribing is the default action, but can be turned off
			return this.subscribe?.(query);
		}
		return new IterableEventQueue();
	}

	// Default permissions (super user only accesss):
	// eslint-disable-next-line no-unused-vars
	allowRead(user: User, target: RequestTarget, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	// eslint-disable-next-line no-unused-vars
	allowUpdate(user: User, record: Promise<Record & RecordObject>, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	// eslint-disable-next-line no-unused-vars
	allowCreate(user: User, record: Promise<Record & RecordObject>, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	// eslint-disable-next-line no-unused-vars
	allowDelete(user: User, target: RequestTarget, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	/**
	 * Get the primary key value for this resource.
	 * @returns primary key
	 */
	getId() {
		return this.#id;
	}
	/**
	 * Get the context for this resource
	 * @returns context object with information about the current transaction, user, and more
	 */
	getContext(): Context | SourceContext {
		return this.#context;
	}

	/**
	 * Get the current user for the current request, based on the context.
	 * @returns user object or undefined if no user is logged in
	 */
	getCurrentUser(): User | undefined {
		return (this.getContext() as Context)?.user;
	}

	get?(
		target?: RequestTargetOrId
	):
		| (Record & Partial<RecordObject>)
		| Promise<Record & Partial<RecordObject>>
		| AsyncIterable<Record & Partial<RecordObject>>
		| Promise<AsyncIterable<Record & Partial<RecordObject>>>;

	search?(target: RequestTargetOrId): AsyncIterable<Record & Partial<RecordObject>>;

	create?(
		newRecord: Partial<Record & RecordObject>,
		target: RequestTargetOrId
	): Promise<Record & Partial<RecordObject>>;
	put?(
		record: Record & RecordObject,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;
	patch?(
		record: Partial<Record & RecordObject>,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;

	delete?(target: RequestTargetOrId): boolean | Promise<boolean>;
	invalidate?(target: RequestTargetOrId): void | Promise<void>;

	publish?(target: RequestTargetOrId, record: Record, options?: any): void;
}

_assignPackageExport('Resource', Resource);

export function snakeCase(camelCase: string) {
	return (
		camelCase[0].toLowerCase() +
		camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters.slice(1))
	);
}

/**
 * This is responsible for arranging arguments in the main static methods and creating the appropriate context and default transaction wrapping
 * @param action
 * @param options
 * @returns
 */
function transactional(
	action: (resource: ResourceInterface, query: RequestTarget, context: Context, data: any) => any,
	options: {
		hasContent: boolean;
		type: 'read' | 'update' | 'create' | 'delete';
		async?: boolean;
		ensureLoaded?: boolean;
	}
) {
	applyContext.reliesOnPrototype = true;
	const hasContent = options.hasContent;
	return applyContext;
	function applyContext(idOrQuery: string | Id | Query, dataOrContext?: any, context?: Context) {
		let id, query, isCollection;
		let data;
		// First we do our argument normalization. There are two main types of methods, with or without content
		if (hasContent) {
			// for put, post, patch, publish, query
			if (context) {
				// if there are three arguments, it is id, data, context
				data = dataOrContext;
				context = context.getContext?.() || context;
			} else if (dataOrContext) {
				// two arguments, more possibilities:
				if (
					typeof idOrQuery === 'object' &&
					idOrQuery &&
					(!Array.isArray(idOrQuery) || typeof idOrQuery[0] === 'object')
				) {
					// (data, context) form
					data = idOrQuery;
					id = data[this.primaryKey] ?? null;
					context = dataOrContext.getContext?.() || dataOrContext;
				} else if (dataOrContext?.transaction instanceof DatabaseTransaction) {
					// (id, context) form
					context = dataOrContext;
				} else {
					// (id, data) form
					data = dataOrContext;
				}
			} else if (idOrQuery && typeof idOrQuery === 'object') {
				// single argument form, just data
				data = idOrQuery;
				idOrQuery = undefined;
				id = data.getId?.() ?? data[this.primaryKey];
			} else {
				throw new ClientError(`Invalid argument for data, must be an object, but got ${idOrQuery}`);
			}
			if (id === null) isCollection = true;
			// otherwise handle methods for get, delete, etc.
			// first, check to see if it is two argument
		} else if (dataOrContext) {
			if (context) {
				// (id, data, context), this a method that doesn't normally have a body/data, but with the three arguments, we have explicit data
				data = dataOrContext;
				context = context.getContext?.() || context;
			} else if (hasContent === false) {
				// (id, context), preferred form used for methods that are explicitly without a body
				context = dataOrContext.getContext?.() || dataOrContext;
			} else if (dataOrContext.transaction || dataOrContext.getContext) {
				// or if it looks like a context
				context = dataOrContext.getContext?.() || dataOrContext;
			} else {
				data = dataOrContext;
			}
		}
		if (id === undefined) {
			if (typeof idOrQuery === 'object' && idOrQuery) {
				// it is a query
				query = idOrQuery;
				if (idOrQuery instanceof URLSearchParams) {
					// already RequestTarget (or URLSearchParams), consider it already parsed,
					// we can just do property parsing, coerce, and assign the id
					id = idOrQuery.id;
					if (this.directURLMapping) {
						id = idOrQuery.toString().slice(1); // remove the leading slash
						query.id = id;
					} else if (typeof id === 'string') {
						// handle paths of the form /path/id.property
						const parsedId = this.parsePath(id, context, query);
						if (parsedId?.id !== undefined) {
							query.property = parsedId.property;
							id = parsedId.id;
						} else {
							id = parsedId;
						}
						if (id) {
							query.id = id = this.coerceId(id);
						}
					}
				} else if (idOrQuery[Symbol.iterator]) {
					// get the id part from an iterable query
					id = [];
					isCollection = true;
					for (const part of idOrQuery) {
						if (typeof part === 'object' && part) break;
						id.push(part);
					}
					if (id.length === 0) id = null;
					else {
						if (id.length === 1) id = id[0];
						if (query.slice) {
							query = query.slice(id.length, query.length);
							if (query.length === 0) {
								query = new RequestTarget();
								query.id = id;
							}
						}
					}
				} else if (id === undefined) {
					id = idOrQuery.id ?? null;
					if (id == null) query.isCollection = true;
				}
			} else {
				id = idOrQuery;
				query = new RequestTarget();
				query.id = id;
				if (id == null) {
					if (options.method === 'get') {
						throw new Error(`Using an argument with a value of ${id} for ${options.method}, is not allowed`);
					}
					query.isCollection = true;
				}
			}
		}
		if (!query) {
			query = new RequestTarget();
			query.id = id;
		}
		isCollection = query.isCollection;
		let resourceOptions;
		if (!context) {
			// try to get the context from the async context if possible
			context = contextStorage.getStore() ?? {};
		}
		if (query.ensureLoaded != null || query.async || isCollection) {
			resourceOptions = { ...options };
			if (query.ensureLoaded != null) resourceOptions.ensureLoaded = query.ensureLoaded;
			if (query.syncAllowed) resourceOptions.syncAllowed = query.syncAllowed;
			if (isCollection) resourceOptions.isCollection = true;
		} else resourceOptions = options;
		const loadAsInstance = this.loadAsInstance;
		if (context?.transaction) {
			// we are already in a transaction, proceed
			const resource = this.getResource(query, context, resourceOptions);
			return resource.then
				? resource.then(authorizeActionOnResource)
				: promiseNormalize(authorizeActionOnResource(resource), resourceOptions);
		} else {
			// start a transaction
			return promiseNormalize(
				transaction(context, () => {
					// record what transaction we are starting from, so that if it times out, we can have an indication of the cause
					context.transaction.startedFrom = {
						resourceName: this.name,
						method: options.method,
					};
					const resource = this.getResource(query, context, resourceOptions);
					return resource.then ? resource.then(authorizeActionOnResource) : authorizeActionOnResource(resource);
				}),
				resourceOptions
			);
		}
		function authorizeActionOnResource(resource: ResourceInterface) {
			let checkPermission = false;
			if (query.checkPermission) {
				checkPermission = true;
				// authorization has been requested, but only do it for this entry call
			}
			if (context.authorize) {
				checkPermission = true;
				// authorization has been requested, but only do it for this entry call
				context.authorize = false;
				query.checkPermission = true;
			}
			if (checkPermission) {
				if (loadAsInstance !== false) {
					// do permission checks, with allow methods
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
							query.checkPermission = false;
							if (!allowed) {
								throw new AccessViolation(context.user);
							}
							return when(data, (data) => {
								return action(resource, query, context, data);
							});
						});
					}
					query.checkPermission = false;
					if (!allowed) {
						throw new AccessViolation(context.user);
					}
				}
			}
			return when(data, (data) => {
				return action(resource, query, context, data);
			});
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
function selectFromObject(object, propertyResolvers, context) {
	// TODO: eventually we will do aggregate functions here
	const record = object.getRecord?.();
	if (record) {
		const ownData = object.getChanges?.();
		return (property) => {
			let value, resolver;
			if (object.hasOwnProperty(property) && typeof (value = object[property]) !== 'function') {
				return value;
			}
			if (ownData && property in ownData) {
				return ownData[property];
			} else if ((resolver = propertyResolvers?.[property])) {
				return resolver(object, context);
			} else return record[property];
		};
	} else if (propertyResolvers) {
		return (property) => {
			const resolver = propertyResolvers[property];
			return resolver ? resolver(object, context) : object[property];
		};
	} else return (property) => object[property];
}
export function transformForSelect(select, resource) {
	const propertyResolvers = resource.propertyResolvers;
	const context = resource.getContext?.();
	let subTransforms;
	if (typeof select === 'string')
		// if select is a single string then return property value
		return function transform(object) {
			if (object.then) return object.then(transform);
			if (Array.isArray(object)) return object.map(transform);
			return selectFromObject(object, propertyResolvers, context)(select);
		};
	else if (typeof select === 'object') {
		// if it is an array, return an array
		if (select.asArray)
			return function transform(object) {
				if (object.then) return object.then(transform);
				if (Array.isArray(object)) return object.map(transform);
				const results = [];
				const getProperty = handleProperty(selectFromObject(object, propertyResolvers, context));
				for (const property of select) {
					results.push(getProperty(property));
				}
				return results;
			};
		const forceNulls = select.forceNulls;
		return function transform(object) {
			if (object.then) return object.then(transform);
			if (Array.isArray(object))
				return object.map((value) => (value && typeof value === 'object' ? transform(value) : value));
			// finally the case of returning objects
			const selectedData = {};
			const getProperty = handleProperty(selectFromObject(object, propertyResolvers, context));
			let promises;
			for (const property of select) {
				let value = getProperty(property);
				if (value === undefined && forceNulls) value = null;
				if (value?.then) {
					if (!promises) promises = [];
					promises.push(value.then((value) => (selectedData[property.name || property] = value)));
				} else selectedData[property.name || property] = value;
			}
			if (promises) return Promise.all(promises).then(() => selectedData);
			return selectedData;
		};
	} else throw new Error('Invalid select argument type ' + typeof select);
	function handleProperty(getProperty) {
		return (property) => {
			if (typeof property === 'string') {
				return getProperty(property);
			} else if (typeof property === 'object') {
				// TODO: Handle aggregate functions
				if (property.name) {
					if (!subTransforms) subTransforms = {};
					// TODO: Get the resource, cache this transform, and apply above
					let transform = subTransforms[property.name];
					if (!transform) {
						const resource = propertyResolvers[property.name]?.definition?.tableClass;
						transform = subTransforms[property.name] = transformForSelect(property.select || property, resource);
					}
					const value = getProperty(property.name);
					return transform(value);
				} else return getProperty(property);
			} else return property;
		};
	}
}
