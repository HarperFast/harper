import * as userRuntimeModule from '../security/user.ts';
import type { User } from '../security/user.ts';
import type { RecordObject } from './RecordEncoder.ts';
import {
	type ResourceInterface,
	type SubscriptionRequest,
	type Id,
	type Context,
	type Query,
	type SourceContext,
	type RequestTargetOrId,
} from './ResourceInterface.ts';
import { randomUUID } from 'node:crypto';
import {
	DatabaseTransaction,
	isJoinableScope,
	isReleasedTransaction,
	type Transaction,
} from './DatabaseTransaction.ts';
import { isReadOnlyMode, readOnlyModeError } from './readOnlyMode.ts';
import { IterableEventQueue } from './IterableEventQueue.ts';
import { _assignPackageExport } from '../globals.js';
import { ClientError, AccessViolation } from '../utility/errors/hdbError.ts';
import { transaction, contextStorage } from './transaction.ts';
import { parseQuery } from './search.ts';
import { RequestTarget } from './RequestTarget.ts';
import { when, promiseNormalize } from '../utility/when.ts';
import { registerLiveSubscription } from '../server/liveSubscriptionAuth.ts';
import type { JsonSchemaFragment } from './jsonSchemaTypes.ts';
import { makeSchemaClass, type Contract, type SchemaClass } from './defineResource.ts';
import { markStaticResourceInstance } from './staticResourceDispatch.ts';
import { isFormDataIterable, resolveBody } from './resolveBody.ts';
import { compareKeys } from 'ordered-binary';

// Only table-backed classes are refused here: a custom resource's put/post/delete may be a non-storage call that a
// read-only server must still answer. post, publish, copy and move are left to the transaction's write admission.
const WRITE_METHODS = new Set(['put', 'patch', 'delete', 'invalidate', 'update']);

function refuseWriteInReadOnlyMode(...args: any[]): Promise<never> {
	// the transport has already started parsing a request body; nothing else will observe it now
	for (const arg of args) if (typeof arg?.then === 'function') arg.then(undefined, () => {});
	return Promise.reject(readOnlyModeError());
}

const AUTHORIZATION_SELECT = Symbol.for('harper.authorizationSelect');
const RELATIONSHIPS_LISTED = Symbol.for('harper.relationshipsListed');
export const SEARCH_AUTHORIZATION = Symbol.for('harper.searchAuthorization');
export const WRITE_CONDITION = Symbol('writeCondition');

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
	/**
	 * The URL path this resource is registered at. When set, it overrides the export-name convention used during
	 * resource registration. A leading `/` makes the path root-relative (top-level); otherwise it is resolved relative
	 * to the component's directory. Paths may contain `:param` and `*wildcard` segments, whose matched values are bound
	 * onto the request target (e.g. `static path = '/widget/:id'` populates `target.id`).
	 */
	static path?: string;
	static directURLMapping = false;
	static loadAsInstance: boolean;
	/** false: a table class evaluates HTTP write preconditions itself, from its request headers */
	static preconditions?: boolean;
	static description?: string;
	static properties?: { [name: string]: JsonSchemaFragment };
	static outputSchemas?: { [verb: string]: JsonSchemaFragment };
	static mcp?: { annotations?: { [verb: string]: { [key: string]: unknown } } };
	static hidden?: boolean;
	/** The per-method request contract, when this resource was built via `withSchema`. */
	static requestContract?: Contract;
	/** Per-verb `{ query?, body? }` input schemas derived from the request contract, read by OpenAPI/MCP. */
	static inputSchemas?: {
		[verb: string]: { query?: JsonSchemaFragment; body?: JsonSchemaFragment; bodyRequired?: boolean };
	};

	/**
	 * Declare a per-method request contract and get back a Resource subclass typed by it. Extend the
	 * returned class and implement the declared verbs; handlers receive the SAME
	 * `RequestTarget`, structurally narrowed (path params typed, `target.get(param)` typed by the query
	 * schema). Each declared verb validates/coerces `query`/`body` before dispatch and returns a
	 * structured 400 on failure, which is what justifies the narrowed types. The contract also feeds
	 * OpenAPI and MCP from the one declaration.
	 */
	static withSchema<Base extends new (...args: any[]) => any, const C extends Contract>(
		this: Base,
		contract: C
	): SchemaClass<Base, C> {
		return makeSchemaClass(this, contract);
	}

	constructor(identifier: Id, source: any) {
		this.#id = identifier;
		const context = source?.getContext ? (source.getContext() ?? null) : undefined;
		this.#context = context !== undefined ? context : source || null;
	}

	doesExist(): boolean {
		return true; // Subclasses should override if needed
	}

	addTo(_property: keyof Record, _value: Record[keyof Record]): void {
		throw new Error('Not implemented');
	}

	subtractFrom(_property: keyof Record, _value: Record[keyof Record]): void {
		throw new Error('Not implemented');
	}

	/**
	 * The get methods are for directly getting a resource, and called for HTTP GET requests.
	 */
	static get = transactional(
		function (resource: any, query: RequestTarget, request: Context, _data: any) {
			const loadAsInstance = resource.constructor.loadAsInstance;
			if (loadAsInstance && query?.select) {
				if ((query as any).parseError) throw (query as any).parseError;
				assertNestedQueryOptions(query.select, resource.constructor);
			}
			const result = resource.get?.(query);
			// only false mode hands allowRead to the instance search; other modes settled it before dispatch
			if (loadAsInstance === false) {
				return result?.then
					? result.then((result: any) => authorizeSearchResult(result, request?.user))
					: authorizeSearchResult(result, request?.user);
			}
			// for the new API we always apply select in the instance method
			if (!loadAsInstance) return result;
			if (result?.then) return result.then(handleSelect);
			return handleSelect(result);
			function handleSelect(result) {
				let select;
				if ((select = query?.select) && result != null && !result.selectApplied) {
					const transform = transformForSelect(select, resource.constructor);
					if (Array.isArray(result)) {
						return settleAll(result.map(transform));
					} else if (typeof result?.map === 'function') {
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
	 * A static override receives the {@link ResourceBody} and owns its resolution and authorization.
	 */
	static put = transactional(
		function (resource: any, query: RequestTarget, request: Context, data: any) {
			if (Array.isArray(data) && resource.#isCollection && resource.constructor.loadAsInstance !== false) {
				const resourceClass = resource.constructor;
				const primaryKey = resourceClass.primaryKey;
				// Before dispatching anything: a malformed body must not race a sibling's write, and a bare
				// dereference below would reach the client as a 500 carrying V8's wording. A primitive is
				// malformed for the same reason — only a Table's own key validation rejects one later, so a
				// plain Resource's override would otherwise be handed it.
				for (let index = 0; index < data.length; index++) {
					const element = data[index];
					if (element == null || typeof element !== 'object')
						throw new ClientError(
							`Array element at index ${index} is ${element === null ? 'null' : typeof element}, expected a record`
						);
				}
				const elementTarget = elementTargetFactory(query);
				const results = [];
				try {
					for (let index = 0; index < data.length; index++) {
						const element = data[index];
						const target = elementTarget(element[primaryKey]);
						const elementResource = resourceClass.getResource(target, request, {
							async: true,
						});
						// `target`, not `request`: this is the target slot, and Table's back-compat shift only
						// recognizes a RequestTarget there — a context is taken for the record.
						// `missingMethod` rather than an unguarded call, so a resource without `put` answers 405
						// here exactly as it does on the single-record path below.
						if (typeof elementResource.then === 'function')
							results.push(
								elementResource.then((resource) =>
									resource.put ? resource.put(element, target) : missingMethod(resource, 'put')
								)
							);
						else if (elementResource.put) results.push(elementResource.put(element, target));
						else missingMethod(elementResource, 'put');
					}
				} catch (error) {
					// Settle the already-dispatched elements or a rejection among them goes unhandled. Then
					// report the earliest-index failure, the same rule `settleElements` applies: every sibling
					// already dispatched precedes the element that threw, so the batch reports the same failure
					// whether that element's dispatch resolved synchronously or asynchronously.
					return Promise.allSettled(results).then((settled) => {
						const failed = settled.find((sibling) => sibling.status === 'rejected');
						if (!failed) throw error;
						throw (failed as PromiseRejectedResult).reason;
					});
				}
				// Not `Promise.all`: settling the batch while a slower element is still resolving lets that
				// element commit outside the failed batch — a partially applied array PUT.
				return settleElements(results);
			}
			return resource.put
				? resource.constructor.loadAsInstance === false
					? resource.put(query, data)
					: resource.put(data, query)
				: missingMethod(resource, 'put');
		},
		{ hasContent: true, type: 'update', method: 'put' }
	);

	/** A static override receives the {@link ResourceBody} and owns its resolution and authorization. */
	static patch = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
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
		function (resource: any, query: RequestTarget, _request: Context, _data: any) {
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
		let id: any;
		if (this.loadAsInstance === false) {
			if (typeof idPrefix === 'object' && idPrefix && !context) {
				// two argument form (record, context), shift the arguments
				context = record;
				record = idPrefix;
				id = new RequestTarget();
				id.isCollection = true;
			} else id = idPrefix;
		} else {
			const primaryKey = (this as any).primaryKey;
			if (idPrefix == null) id = record?.[primaryKey] ?? this.getNewId();
			else if (Array.isArray(idPrefix) && typeof idPrefix[0] !== 'object')
				id = record?.[primaryKey] ?? [...idPrefix, this.getNewId()];
			else if (typeof idPrefix !== 'object') id = record?.[primaryKey] ?? [idPrefix, this.getNewId()];
			else {
				// two argument form, shift the arguments
				id = idPrefix?.[primaryKey] ?? this.getNewId();
				context = record || {};
				record = idPrefix;
			}
		}
		if (isReleasedTransaction(context)) context = undefined;
		if (context) {
			if ((context as any).getContext) context = (context as any).getContext();
		} else {
			// try to get the context from the async context if possible
			context = contextStorage.getStore() ?? {};
		}
		return transaction(context, async () => {
			(context as any).transaction.startedFrom ??= {
				resourceName: this.name,
				method: 'create',
			};
			const resource = new (this as any)(id, context);
			const results = resource.create ? await resource.create(id, record) : missingMethod(resource, 'create');
			(context as any).newLocation = id ?? results?.[(this as any).primaryKey];
			(context as any).createdResource = true;
			return this.loadAsInstance === false ? results : resource;
		});
	}
	static invalidate = transactional(
		function (resource: any, query: RequestTarget, _request: Context, _data: any) {
			return resource.invalidate ? resource.invalidate(query) : missingMethod(resource, 'invalidate');
		},
		{ hasContent: false, type: 'update', method: 'invalidate' }
	);

	/** A static override receives the {@link ResourceBody} and owns its resolution and authorization. */
	static post = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
			if (resource.#id != null) resource.update?.(); // save any changes made during post
			return resource.constructor.loadAsInstance === false ? resource.post(query, data) : resource.post(data, query);
		},
		{ hasContent: true, type: 'create', method: 'post' }
	);

	static update = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
			return resource.update(query, data);
		},
		{ type: 'update', method: 'update' }
	);

	static connect = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
			return resource.connect
				? resource.constructor.loadAsInstance === false
					? resource.connect(query, data)
					: resource.connect(data, query)
				: missingMethod(resource, 'connect');
		},
		{ hasContent: true, type: 'read', method: 'connect' }
	);

	static subscribe = transactional(
		function (resource: any, query: RequestTarget, _request: Context, _data: any) {
			return resource.subscribe ? resource.subscribe(query) : missingMethod(resource, 'subscribe');
		},
		{ type: 'read', method: 'subscribe', syncAllowed: true }
	);

	static publish = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
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
		function (resource: any, query: Query, request: Context) {
			const result = resource.search ? resource.search(query) : missingMethod(resource, 'search');
			return when(result, (result: any) =>
				when(authorizeSearchResult(result, request?.user), (result: any) => {
					const select = (request as any).select;
					if (select && request.hasOwnProperty('select') && result != null && !result.selectApplied) {
						const transform = transformForSelect(select, resource.constructor);
						return Array.isArray(result) ? settleAll(result.map(transform)) : result.map(transform);
					}
					return result;
				})
			);
		},
		{ type: 'read', method: 'search', hasContent: false, syncAllowed: true }
	);

	static query = transactional(
		function (resource: any, query: RequestTarget, request: Context, data: any) {
			// Table.allowRead applies attribute permissions to the URL target. QUERY executes the
			// separately parsed body target, so carry the framework-narrowed projection across after
			// authorization. Never copy permission-control fields from the client body.
			if (
				resource.constructor.loadAsInstance !== false &&
				data &&
				typeof data === 'object' &&
				(query as any)[AUTHORIZATION_SELECT]
			) {
				const allowed = Array.isArray(query.select) ? query.select : [query.select];
				if (Object.prototype.hasOwnProperty.call(data, 'select') && data.select != null) {
					const requested = Array.isArray(data.select) ? data.select : [data.select];
					const requestedNames = new Set(requested.map((property: any) => property?.name ?? property));
					const narrowed: any = requestedNames.has('*')
						? allowed.slice()
						: allowed.filter((property: any) => requestedNames.has(property?.name ?? property));
					if (Array.isArray(data.select)) {
						if (data.select.asArray) narrowed.asArray = true;
						if (data.select.forceNulls) narrowed.forceNulls = true;
					}
					if (allowed[RELATIONSHIPS_LISTED]) narrowed[RELATIONSHIPS_LISTED] = true;
					data.select = narrowed;
				} else {
					data.select = query.select;
				}
			}
			const result = resource.search
				? resource.constructor.loadAsInstance === false
					? resource.search(query, data)
					: resource.search(data, query)
				: missingMethod(resource, 'search');
			return when(result, (result: any) => authorizeSearchResult(result, request?.user));
		},
		{ hasContent: true, type: 'read', method: 'query' }
	);

	static copy = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
			return resource.copy
				? resource.constructor.loadAsInstance === false
					? resource.copy(query, data)
					: resource.copy(data, query)
				: missingMethod(resource, 'copy');
		},
		{ hasContent: true, type: 'create', method: 'copy' }
	);

	static move = transactional(
		function (resource: any, query: RequestTarget, _request: Context, data: any) {
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
		if ((this.constructor as any).loadAsInstance === false) {
			if ((target as any).isCollection && this.create) {
				newRecord = (await this.create(target as any, newRecord)) as any;
				return newRecord?.[(this.constructor as any).primaryKey as keyof typeof newRecord] as any;
			}
		} else {
			if (this.#isCollection) {
				const resource = await (this.constructor as any).create(this.#id, target, this.#context);
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
			} else if (
				(this as any).attributes?.find((attribute) => attribute.name === property) ||
				// A programmatic Resource may declare `static properties` (a Record keyed by attribute
				// name) without an `attributes` Array. Use an OWN-key check (not `properties[property]`,
				// which would match inherited Object.prototype members like `constructor`/`toString`) —
				// O(1), so no per-request projection on this path.
				(this.properties != null && Object.hasOwn(this.properties, property))
			) {
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
		let context = (request as any).getContext?.();
		let isCollection;
		if (typeof (request as any).isCollection === 'boolean' && request.hasOwnProperty('isCollection'))
			isCollection = (request as any).isCollection;
		else isCollection = options?.isCollection;
		// if it is a collection and we have a collection class defined, use it
		const constructor = (isCollection && (this as any).Collection) || this;
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
	subscribe(request: SubscriptionRequest): AsyncIterable<Record> | Promise<AsyncIterable<Record>> {
		return new IterableEventQueue();
	}

	connect(
		target: RequestTarget,
		incomingMessages: IterableEventQueue<Record>
	): AsyncIterable<Record> | Promise<AsyncIterable<Record>> {
		// convert subscription to an (async) iterator
		const query = (this.constructor as any).loadAsInstance === false ? target : incomingMessages;
		if ((query as any)?.subscribe !== false) {
			// subscribing is the default action, but can be turned off
			return this.subscribe?.(query as any) as any;
		}
		return new IterableEventQueue();
	}

	// Default permissions (super user only accesss):
	/** @deprecated Override the resource operation to perform application authorization with the complete request. */
	// eslint-disable-next-line no-unused-vars
	allowRead(user: User, target: RequestTarget, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	/** @deprecated Override the resource operation to perform application authorization with the complete request. */
	// eslint-disable-next-line no-unused-vars
	allowUpdate(user: User, record: Record, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	/** @deprecated Override the resource operation to perform application authorization with the complete request. */
	// eslint-disable-next-line no-unused-vars
	allowCreate(user: User, record: Record, context: Context): boolean | Promise<boolean> {
		return user?.role.permission.super_user;
	}
	/** @deprecated Override the resource operation to perform application authorization with the complete request. */
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
		target: RequestTargetOrId,
		newRecord: Partial<Record & RecordObject>
	): void | (Record & Partial<RecordObject>) | Promise<Record & Partial<RecordObject>>;
	put?(
		record: Record & RecordObject,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;
	patch?(
		record: Partial<Record & RecordObject>,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;

	delete?(target: RequestTargetOrId): boolean | Promise<boolean>;
	invalidate(_target: RequestTargetOrId): void | Promise<void> {
		missingMethod(this, 'invalidate');
	}

	publish?(target: RequestTargetOrId, record: Record, options?: any): void;
}

_assignPackageExport('Resource', Resource);

/**
 * allowRead implementations whose result, for a target with no caller-supplied `select`, reads only the
 * user's role permission and the resource class, so a live-subscription recheck pass may share it across
 * subscriptions of one class.
 */
export const defaultAllowReads = new WeakSet<(...args: any[]) => unknown>([Resource.prototype.allowRead]);

/** @internal Captured at load, before application code can replace it. */
export const defaultGetResource = Resource.getResource;

/**
 * @internal Registered per exact class, so subclasses never match. On NOT_HANDLED the general dispatch
 * continues with the context resolved for the getter, so a getter must not consume its arguments.
 */
type PrimitiveIdGet = (id: string | number, context: Context, resourceOptions: any) => any;
const primitiveIdGets = new WeakMap<object, PrimitiveIdGet>();
/** @internal */
export const NOT_HANDLED = Symbol('not-handled');
/** @internal */
export function registerPrimitiveIdGet(resourceClass: object, get: PrimitiveIdGet): void {
	primitiveIdGets.set(resourceClass, get);
}
/** @internal */
export function primitiveIdGetFor(resourceClass: object): PrimitiveIdGet | undefined {
	return primitiveIdGets.get(resourceClass);
}
/** @internal */
export class LoadingResource {
	loaded: Promise<ResourceInterface>;
	constructor(loaded: Promise<ResourceInterface>) {
		this.loaded = loaded;
	}
}

export function snakeCase(camelCase: string) {
	return (
		camelCase[0].toLowerCase() +
		camelCase.slice(1).replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters.slice(1))
	);
}

/**
 * Mint per-element targets for a fanned-out batch write. Each element needs its own object — its id
 * must not be visible to a sibling whose dispatch resolves later — but it also needs the request's
 * query and route metadata, which a `put()` override can read. The request's contribution is
 * therefore resolved once here rather than deep-cloned per element, and nested metadata is shared
 * rather than copied. `checkPermission` never carries: the collection receiver's single verdict is
 * authoritative and per-element dispatch must not re-arm it.
 */
function elementTargetFactory(query: any): (id: any) => RequestTarget {
	const base = cloneRequestTarget(query);
	const search = base.toString();
	// Only what the element target would not otherwise have. `RequestTarget` declares `pathname`,
	// `search` and `sort` without `declare`, so they are own properties on every instance and would
	// otherwise always be "carried" — overwriting what this element's own construction just derived,
	// and making the skip below dead. A nullish own value carries no metadata either.
	const carried: Record<string, any> = {};
	for (const key of Object.keys(base)) {
		if (key === 'id' || key === 'isCollection' || key === 'pathname' || key === 'search') continue;
		const value = (base as any)[key];
		if (value != null) carried[key] = value;
	}
	const hasCarried = Object.keys(carried).length > 0;
	return (id) => {
		const target = search ? new RequestTarget(search) : new RequestTarget();
		if (hasCarried) Object.assign(target, carried);
		target.id = id;
		target.isCollection = false;
		return target;
	};
}

/**
 * Report a fanned-out batch write's outcome only once every element has staged or failed its own
 * write, so the enclosing transaction cannot unwind under one. Rejects with the first failure.
 */
function settleElements(results: any[]): Promise<any[]> {
	return Promise.allSettled(results).then((settled) => {
		const values = new Array(settled.length);
		for (let index = 0; index < settled.length; index++) {
			const element = settled[index];
			if (element.status === 'rejected') throw element.reason;
			values[index] = element.value;
		}
		return values;
	});
}

/**
 * This is responsible for arranging arguments in the main static methods and creating the appropriate context and default transaction wrapping
 * @param action
 * @param options
 * @returns
 */
function transactional(
	action: (resource: any, query: RequestTarget, context: Context, data: any) => any,
	options: {
		hasContent?: boolean;
		type: 'read' | 'update' | 'create' | 'delete';
		async?: boolean;
		ensureLoaded?: boolean;
		letItLinger?: boolean;
		method?: string;
		syncAllowed?: boolean;
	}
) {
	applyContext.reliesOnPrototype = true;
	const hasContent = options.hasContent;
	const writesByDefinition = options.method !== undefined && WRITE_METHODS.has(options.method);
	const collectForms = ['post', 'put', 'patch', 'query'].includes(options.method);
	// a primitive-id getter takes the second argument as the context, as only a body-less get does
	const isGet = options.method === 'get' && hasContent === false;
	return applyContext;
	function applyContext(idOrQuery: string | Id | Query, dataOrContext?: any, context?: Context) {
		if (writesByDefinition && isReadOnlyMode() && (this as any).primaryStore)
			return refuseWriteInReadOnlyMode(idOrQuery, dataOrContext);
		let id, query, isCollection;
		let data;
		// An absent argument, not a context — and not this call's data either.
		if (isReleasedTransaction(dataOrContext)) dataOrContext = undefined;
		if (isReleasedTransaction(context)) context = undefined;
		let loadingResource: Promise<ResourceInterface> | undefined;
		if (isGet && !context && (typeof idOrQuery === 'string' || typeof idOrQuery === 'number')) {
			const getPrimitiveId = primitiveIdGets.get(this);
			if (getPrimitiveId) {
				context = dataOrContext
					? (dataOrContext as any).getContext?.() || dataOrContext
					: (contextStorage.getStore() ?? {});
				dataOrContext = undefined;
				if (isJoinableScope(context.transaction)) {
					const result = getPrimitiveId(idOrQuery, context, options);
					if (result instanceof LoadingResource) loadingResource = result.loaded;
					else if (result !== NOT_HANDLED) return promiseNormalize(result, options as any);
				}
			}
		}
		// First we do our argument normalization. There are two main types of methods, with or without content
		if (hasContent) {
			// for put, post, patch, publish, query
			if (context) {
				// if there are three arguments, it is id, data, context
				data = dataOrContext;
				context = (context as any).getContext?.() || context;
			} else if (dataOrContext) {
				// two arguments, more possibilities:
				if (
					typeof idOrQuery === 'object' &&
					idOrQuery &&
					!(idOrQuery instanceof URLSearchParams) &&
					(!Array.isArray(idOrQuery) || typeof idOrQuery[0] === 'object')
				) {
					// (data, context) form
					data = idOrQuery;
					id = data[this.primaryKey] ?? null;
					context = (dataOrContext as any).getContext?.() || dataOrContext;
					if (context instanceof DatabaseTransaction) context = { transaction: context };
				} else if (dataOrContext instanceof DatabaseTransaction) {
					// (id, txn) form
					context = { transaction: dataOrContext };
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
			} else if (idOrQuery != null && typeof idOrQuery !== 'object') {
				// single argument form, just id
				id = idOrQuery;
				data = undefined;
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
				context = (context as any).getContext?.() || context;
			} else if (hasContent === false) {
				// (id, context), preferred form used for methods that are explicitly without a body
				context = (dataOrContext as any).getContext?.() || dataOrContext;
			} else if (dataOrContext.transaction || dataOrContext.getContext) {
				// or if it looks like a context
				context = (dataOrContext as any).getContext?.() || dataOrContext;
			} else {
				data = dataOrContext;
			}
		}
		if (options.method === 'query' && (typeof data?.then === 'function' || isFormDataIterable(data))) {
			// HTTP request bodies are resolved asynchronously. QUERY projection and permission-control
			// sanitization must happen before resource resolution and allowRead, not later in runAction.
			const dataWasFirstArgument = data === idOrQuery;
			return resolveBody(data, true, (resolvedData: any) =>
				dataWasFirstArgument
					? applyContext.call(this, resolvedData, context)
					: applyContext.call(this, idOrQuery, resolvedData, context)
			);
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
					id = (idOrQuery as any).id ?? null;
					if (id == null) query.isCollection = true;
				}
			} else {
				id = idOrQuery;
				query = new RequestTarget();
				query.id = id;
				if (id == null) {
					if (options.method === 'get' || options.method === 'delete') {
						// For delete, a bare null/undefined id would be coerced into a whole-collection
						// target and silently delete every record (studio#1199); a deliberate delete-all
						// must use an explicit query object instead.
						throw new ClientError(`Using an argument with a value of ${id} for ${options.method}, is not allowed`);
					}
					query.isCollection = true;
				}
			}
		}
		if (!query) {
			query = new RequestTarget();
			query.id = id;
			// The collection inferred from the batch's null id has to survive onto the synthesized target,
			// or the array is dispatched as one record update against a null primary key. Array-only:
			// a null id on non-array data means auto-generate, not collection.
			if (isCollection && options.method === 'put' && Array.isArray(data)) query.isCollection = true;
		}
		if (options.method === 'query' && data && typeof data === 'object') {
			// QUERY executes the independently parsed body target. Make its requested projection (and, for an
			// instance resource, its conditions and sort) part of the operation admission target, but remove
			// framework-owned permission controls before either target reaches application or table code.
			// Iterables are materialized once: admission and execution both read them.
			if (hasPermissionControl(data)) data = cloneRequestTarget(data);
			if (Object.prototype.hasOwnProperty.call(data, 'select')) query.select = data.select;
			if (this.loadAsInstance !== false) {
				if (Object.prototype.hasOwnProperty.call(data, 'conditions')) {
					if (data.conditions && !Array.isArray(data.conditions) && data.conditions[Symbol.iterator])
						data.conditions = Array.from(data.conditions);
					query.conditions = data.conditions;
				} else if (data instanceof URLSearchParams) query.conditions = Array.from(data);
				else if (data[Symbol.iterator]) {
					if (!Array.isArray(data)) data = Array.from(data);
					query.conditions = data;
				}
				if (Object.prototype.hasOwnProperty.call(data, 'sort')) query.sort = data.sort;
			}
		}
		isCollection = query.isCollection;
		if (options.method === 'post' && query.id === null && !isCollection) {
			if (this.prototype.post === Resource.prototype.post) {
				// exact base-path match with no trailing slash (harper#678): the default post dispatch
				// has nothing to address, so reject with a purpose-built message
				throw new ClientError(`A trailing slash is required to POST to the ${this.name} collection`, 404);
			}
			if (this.loadAsInstance !== false) {
				// a custom instance post() override accepts the no-slash collection POST (redirector-style
				// bulk import); normalize it so authorization and dispatch use collection semantics
				query.isCollection = true;
				isCollection = true;
			}
		}
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
		// Only join an existing transaction that can actually be a scope (isJoinableScope: OPEN, and it
		// stages its writes rather than committing each one — the same gate resources/transaction.ts's
		// transaction() helper applies to itself). Beyond that, a `context` object can carry a *stale*
		// `.transaction` left over from an earlier, unrelated call that
		// already ran to completion: ambient contexts obtained via contextStorage.getStore() are
		// no longer guaranteed to be fresh, one-shot objects now that processLocalTransaction (#1591/
		// #1592) installs one shared, long-lived context for the lifetime of an entire operation
		// handler. Without this check, a second, logically-independent static Resource API call made
		// later in the same handler (no explicit context of its own) would see that leftover
		// `.transaction` reference and wrongly treat it as "still open," silently folding its write
		// into a transaction whose commit lifecycle was already driven to completion by the first
		// call — coalescing two unrelated writes and risking the first one being dropped. See
		// harper-pro's replication/subscriptionManager.ts ensureNode(), which is called twice in
		// sequence (once for this node, once for a peer) from a single add_node/add_node_back
		// operation handler and reproduced this exact loss in a live cluster-formation test.
		//
		// A transaction that is no longer OPEN reached that state one of two ways, and they need
		// opposite treatment:
		//  - committed: the prior call ran to completion normally. Safe to silently start a fresh
		//    transaction for this independent call (the case above).
		//  - poisoned (`timedOut`, #1411; or `disconnected`, harper#2001): the whole logical operation
		//    must fail atomically, not have this write quietly land on a brand-new transaction while
		//    the earlier write(s) were rolled back. Joining the poisoned transaction here (instead of
		//    starting fresh) makes the write throw transactionOpenTooLongError/requestAbortedError via
		//    addWrite()/commit()'s poison check, correctly propagating the abort to the caller. See
		//    integrationTests/resources/txn-overtime-atomicity.test.ts.
		if (isJoinableScope(context?.transaction) || context?.transaction?.timedOut || context?.transaction?.disconnected) {
			// we are already in a transaction (or it was poisoned and must fail), proceed
			const resource = loadingResource ?? this.getResource(query, context, resourceOptions);
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
			// For subscribe, register the resulting subscription for continuous re-authorization so it is
			// terminated if the principal later loses access or its token expires (#1414). Non-subscribe
			// actions run unchanged.
			// 'subscribe' is the direct MQTT path; 'connect' is the SSE/WebSocket path (REST CONNECT) —
			// both resolve to the same subscription iterable.
			const isSubscribeAction = options.method === 'subscribe' || options.method === 'connect';
			// read before allowRead, which may write a select of its own
			const selectedByCaller = isSubscribeAction && query?.select != null;
			const runAction = (data: any) => {
				// Capture the complete target after the initial allowRead has narrowed it, but before
				// subscribe/connect implementations can mutate it. Every later recheck gets a fresh clone.
				const admittedTarget = isSubscribeAction ? cloneRequestTarget(query) : undefined;
				// getResource creates a fresh receiver for this dispatch. Marking that receiver, rather
				// than caller-owned target identity, preserves the static (target, message) signature when
				// an override copies the target or delegates asynchronously after its own return settles.
				if (loadAsInstance === false && options.method === 'publish') markStaticResourceInstance(resource);
				const result = action(resource, query, context, data);
				if (!isSubscribeAction) return result;
				return when(result, (subscription: any) =>
					registerLiveSubscriptionForContext(subscription, resource, admittedTarget, selectedByCaller, context)
				);
			};
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
			return resolveBody(data, collectForms, authorizeResolvedBody);
			function authorizeResolvedBody(data: any) {
				if (checkPermission) {
					if (loadAsInstance !== false) {
						// do permission checks, with allow methods
						let allowed;
						try {
							allowed =
								options.type === 'read'
									? resource.allowRead(context.user, query, context)
									: options.type === 'update'
										? resource.doesExist?.() === false
											? resource.allowCreate(context.user, data, context)
											: resource.allowUpdate(context.user, data, context)
										: options.type === 'create'
											? resource.allowCreate(context.user, data, context)
											: resource.allowDelete(context.user, query, context);
						} catch {
							// allow* threw — fail closed rather than letting the request proceed
							throw new AccessViolation(context.user);
						}
						if ((allowed as any)?.then) {
							return (allowed as any).then(
								(allowed) => {
									query.checkPermission = false;
									if (!allowed) {
										throw new AccessViolation(context.user);
									}
									return runAction(data);
								},
								() => {
									// async allow* rejected — fail closed
									throw new AccessViolation(context.user);
								}
							);
						}
						query.checkPermission = false;
						if (!allowed) {
							throw new AccessViolation(context.user);
						}
					}
				}
				return runAction(data);
			}
		}
	}
}

function authorizeSearchResult(result: any, user: any) {
	const authorization = result?.[SEARCH_AUTHORIZATION] ?? (result?.headers && result.data?.[SEARCH_AUTHORIZATION]);
	return authorization
		? when(authorization, (state: any) => {
				if (state && typeof state === 'object') {
					if (state.error) throw state.error;
					if (!state.allowed) throw new AccessViolation(user);
					// only the gate itself is replaced: a transform derived from it must still run
					const { gate } = state;
					if (gate) {
						if (result === gate) return state.results;
						if (result.headers && result.data === gate) {
							if (Object.isFrozen(result)) return { ...result, data: state.results };
							result.data = state.results;
						}
					}
				} else if (!state) throw new AccessViolation(user);
				return result;
			})
		: result;
}

function cloneRequestTarget(source: any): RequestTarget {
	const clone = new RequestTarget(source instanceof URLSearchParams ? source.toString() : undefined);
	const seen = new WeakMap<object, any>();
	const cloneValue = (value: any): any => {
		if (value == null || typeof value !== 'object') return value;
		if (seen.has(value)) return seen.get(value);
		if (Array.isArray(value)) {
			const copy: any[] = [];
			seen.set(value, copy);
			for (const key of Object.keys(value)) {
				if (key !== 'checkPermission') copy[key] = cloneValue(value[key]);
			}
			return copy;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return value;
		const copy = Object.create(prototype);
		seen.set(value, copy);
		for (const key of Object.keys(value)) {
			if (key !== 'checkPermission') copy[key] = cloneValue(value[key]);
		}
		return copy;
	};
	seen.set(source, clone);
	for (const key of Object.keys(source ?? {})) {
		if (key !== 'checkPermission') (clone as any)[key] = cloneValue(source[key]);
	}
	return clone;
}

function hasPermissionControl(value: any, seen = new WeakSet<object>()): boolean {
	if (value == null || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	if (Object.prototype.hasOwnProperty.call(value, 'checkPermission')) return true;
	for (const key of Object.keys(value)) {
		if (hasPermissionControl(value[key], seen)) return true;
	}
	return false;
}

let securityUser: typeof import('../security/user.ts') | undefined;

const resolveUser = (_scope: unknown, username: string) =>
	securityUser!.findAndValidateUser(username, undefined, false);

/** Returns `subscription`, or a promise of it once a principal stale at admission has been rechecked. */
function registerLiveSubscriptionForContext(
	subscription: any,
	resource: any,
	admittedTarget: any,
	selectedByCaller: boolean,
	context: Context
) {
	const user: any = context?.user;
	const username = user?.username;
	securityUser ??= userRuntimeModule;
	// Internal watchers and replication have no user principal, and no record backs the local
	// principal — nothing to re-authorize.
	if (!username || securityUser!.isLocalPrincipal(user)) return subscription;
	// no subscription, or one already closed (a refused resume): nothing will be delivered to revoke
	if (!subscription || typeof subscription !== 'object' || subscription.closed) return subscription;
	const { cloneUserView, hasRecordProvenance, isCurrentUser } = securityUser!;
	// Without a caller's select or a condition or sort through a relationship, the default allowRead only
	// narrows what it returns, so its verdict depends on the role's permission for this table alone.
	const sharedDecision =
		!selectedByCaller &&
		defaultAllowReads.has(resource.allowRead) &&
		!resource.constructor._referencesRelationship?.(admittedTarget);
	const evaluate = (principal: any) => {
		const reTarget: any = cloneRequestTarget(admittedTarget);
		reTarget.checkPermission = principal.role?.permission;
		return resource.allowRead(principal, reTarget, context);
	};
	const handle = registerLiveSubscription({
		subscription,
		username,
		// JWT exp of the bearer credential (set by the auth layer); undefined for password/mTLS/session.
		authExpiresAt: user.authExpiresAt,
		// A principal with no record provenance (a component's server.getUser on a path that does not track it)
		// can't be checked for staleness at admission, so every tick rechecks it.
		identityOnly: sharedDecision && (user._scopedToken || hasRecordProvenance(user)),
		recheck: async (pass) => {
			let fresh: any;
			let viewer: any;
			if (user._scopedToken) {
				// A scoped token's identity IS its embedded role — never re-resolve its attribution
				// username against hdb_user (it may not exist, or may name an unrelated principal
				// created later). Expiry (authExpiresAt above) is its only revocation.
				fresh = viewer = user;
			} else {
				// Re-read current user state from hdb_user/hdb_role, once per username per pass, so a dropped
				// or role-stripped user no longer authorizes.
				fresh = await pass.memo(resolveUser, username, resolveUser);
				if (!fresh?.role) return false;
				// Advance the subscription's context to the fresh user so downstream checks — context.user
				// and getCurrentUser() (which reads the resource's context) — evaluate against current state,
				// not the stale user captured at subscribe time. Each context gets its own view, which its
				// code may modify.
				viewer = cloneUserView(fresh);
				if (context) (context as any).user = viewer;
			}
			// Re-run the same operation-level allowRead that granted the subscription.
			return !!(await (sharedDecision ? pass.memo(fresh, resource.constructor, evaluate) : evaluate(viewer)));
		},
	});
	let stale: boolean;
	try {
		stale = !isCurrentUser(user);
	} catch {
		stale = true;
	}
	if (!stale) return subscription;
	// Admitted by records that changed before it registered, so the notification for that change may already
	// have run without it: recheck before any delivery.
	return handle.verify().then((outcome) => {
		if (outcome === 'revoked') throw new AccessViolation(user);
		// closed by its owner meanwhile, perhaps with a terminal error the caller acts on
		return subscription;
	});
}

const KNOWN_METHODS = ['get', 'head', 'put', 'post', 'delete', 'patch', 'query', 'move', 'copy'];
type ClientErrorWithMethods = ClientError & { allow: string[]; method: string };
export function missingMethod(resource: any, method: string) {
	const error = new ClientError(
		`The ${resource.constructor.name} does not have a ${method} method implemented`,
		405
	) as ClientErrorWithMethods;
	error.allow = allowedMethods(resource);
	error.method = method;
	throw error;
}

export function allowedMethods(resource: any) {
	const allow = [];
	for (const method of KNOWN_METHODS) {
		if (typeof resource[method] === 'function') allow.push(method);
	}
	return allow;
}

// an inherited `__proto__` is the object's prototype (a table record's carries accessors), not data
export function readSelectedProperty(object: any, property: string) {
	return property === '__proto__' && !Object.hasOwn(object, property) ? undefined : object[property];
}
/**
 * This is responsible for handling a select query parameter/call that selects specific
 * properties from the returned record(s).
 * @param object
 * @returns
 */
function selectFromObject(object, propertyResolvers, context, selectsPrototype: boolean) {
	// TODO: eventually we will do aggregate functions here
	return (property) => readPropertyFromObject(object, property, propertyResolvers, context, selectsPrototype);
}
export const ownDataProperty = { value: undefined, writable: true, enumerable: true, configurable: true };
function settleAll(results: any[]) {
	for (let i = 0, l = results.length; i < l; i++) {
		if (typeof results[i]?.then === 'function') return Promise.all(results);
	}
	return results;
}
export function hasNestedQueryOptions(property) {
	return (
		property &&
		typeof property === 'object' &&
		((property.conditions !== undefined && (!Array.isArray(property.conditions) || property.conditions.length > 0)) ||
			property.operator !== undefined ||
			property.limit !== undefined ||
			property.offset !== undefined ||
			(typeof property.sort === 'object' && property.sort))
	);
}

export function assertNestedQueryOptions(select, resource) {
	for (const property of Array.isArray(select) ? select : select ? [select] : []) {
		if (!property || typeof property !== 'object') continue;
		const related = resource?.propertyResolvers?.[property.name]?.definition?.tableClass;
		if (
			((property.conditions !== undefined && (!Array.isArray(property.conditions) || property.conditions.length > 0)) ||
				property.operator !== undefined) &&
			(!resource?._prepareRelationshipSelection || !related)
		)
			throw new ClientError('Nested query constraints require a relationship attribute');
		assertNestedQueryOptions(property.select || (Array.isArray(property) ? property : undefined), related);
	}
}

export function transformForSelect(select, resource) {
	assertNestedQueryOptions(select, resource);
	const propertyResolvers = resource?.propertyResolvers;
	const context = resource?.getContext?.();
	let subTransforms: Map<any, (object: any) => any>;
	if (
		select === '*' ||
		(!resource && Array.isArray(select) && select.length === 1 && select[0] === '*' && !(select as any).asArray)
	)
		return function transform(object) {
			return typeof object?.then === 'function' ? object.then(transform) : object;
		};
	let relationshipSelections;
	if (resource?._prepareRelationshipSelection)
		for (const property of Array.isArray(select) ? select : select ? [select] : []) {
			if (propertyResolvers?.[property?.name]?.definition?.tableClass && hasNestedQueryOptions(property)) {
				(relationshipSelections ||= Object.create(null))[property.name] = resource._prepareRelationshipSelection(
					property,
					context ?? contextStorage.getStore()
				);
			}
		}
	if (typeof select === 'string')
		return function transform(object) {
			if (object == null || (!resource && typeof object !== 'object')) return object;
			if (typeof object.then === 'function') return object.then(transform);
			if (Array.isArray(object)) return settleAll(object.map(transform));
			return readPropertyFromObject(object, select, propertyResolvers, context, select === '__proto__');
		};
	if (!Array.isArray(select) && select?.name !== undefined)
		return function transform(object) {
			if (object == null || (!resource && typeof object !== 'object')) return object;
			if (typeof object.then === 'function') return object.then(transform);
			if (Array.isArray(object)) return settleAll(object.map(transform));
			return handleProperty(
				selectFromObject(object, propertyResolvers, context, select.name === '__proto__'),
				object
			)(select);
		};
	else if (Array.isArray(select)) {
		// if it is an array, return an array
		const selectsPrototype = select.some((property) => (property?.name ?? property) === '__proto__');
		if ((select as any).asArray)
			return function transform(object) {
				if (object == null || (!resource && typeof object !== 'object')) return object;
				if (typeof object.then === 'function') return object.then(transform);
				if (Array.isArray(object)) return settleAll(object.map(transform));
				const results = [];
				const getProperty = handleProperty(
					selectFromObject(object, propertyResolvers, context, selectsPrototype),
					object
				);
				let pending = false;
				for (const property of select) {
					const value = property === '*' ? object : getProperty(property);
					if (typeof value?.then === 'function') pending = true;
					results.push(value);
				}
				return pending ? Promise.all(results) : results;
			};
		const forceNulls = (select as any).forceNulls;
		const selectsWildcard = select.includes('*');
		return function transform(object) {
			if (object == null || (!resource && typeof object !== 'object')) return object;
			if (typeof object.then === 'function') return object.then(transform);
			if (Array.isArray(object))
				return settleAll(object.map((value) => (value && typeof value === 'object' ? transform(value) : value)));
			// a tracked instance's toJSON() is its current view: record, folded pending changes and own fields
			const wildcardSource =
				selectsWildcard &&
				!(ArrayBuffer.isView(object) || object instanceof Date || object instanceof Blob) &&
				(typeof object.getRecord !== 'function'
					? object
					: typeof object.toJSON === 'function'
						? object.toJSON()
						: object.getRecord());
			// finally the case of returning objects
			const selectedData = {};
			const getProperty = handleProperty(
				selectFromObject(object, propertyResolvers, context, selectsPrototype),
				object
			);
			if (selectsPrototype) Object.defineProperty(selectedData, '__proto__', ownDataProperty);
			let promises;
			for (const property of select) {
				if (property === '*') {
					if (select[RELATIONSHIPS_LISTED] && resource?._copyUnlistedAttributes)
						resource._copyUnlistedAttributes(wildcardSource || object, selectedData);
					else if (wildcardSource)
						for (const key in wildcardSource) {
							const value = wildcardSource[key];
							if (typeof value === 'function') continue;
							if (key === '__proto__') Object.defineProperty(selectedData, key, { ...ownDataProperty, value });
							else selectedData[key] = value;
						}
					continue;
				}
				let value = getProperty(property);
				if (value === undefined && forceNulls) value = null;
				if (typeof value?.then === 'function') {
					if (!promises) promises = [];
					promises.push(
						value.then(
							(value) => (selectedData[property.name || property] = value === undefined && forceNulls ? null : value)
						)
					);
				} else selectedData[property.name || property] = value;
			}
			if (promises) return Promise.all(promises).then(() => selectedData);
			return selectedData;
		};
	} else throw new ClientError('Invalid select, expected an attribute name or a list of attributes');
	function projectNested(property, value) {
		if (!value || typeof value !== 'object' || value instanceof Date) return value;
		if (typeof value.then === 'function') return value.then((value) => projectNested(property, value));
		if (!subTransforms) subTransforms = new Map();
		let transform = subTransforms.get(property);
		if (!transform) {
			transform = nestedTransform(property);
			subTransforms.set(property, transform);
		}
		return transform(value);
	}
	function nestedTransform(property) {
		const targetResource =
			propertyResolvers && Object.hasOwn(propertyResolvers, property.name)
				? propertyResolvers[property.name]?.definition?.tableClass
				: undefined;
		return nestedSelectTransform(property, targetResource);
	}
	function handleProperty(getProperty, object) {
		return (property) => {
			if (typeof property === 'string') {
				return getProperty(property);
			} else if (typeof property === 'object') {
				// TODO: Handle aggregate functions
				if (property.name) {
					const selection = relationshipSelections?.[property.name];
					if (selection)
						return selection(typeof object.getRecord === 'function' ? object.getRecord() || object : object);
					return projectNested(property, getProperty(property.name));
				} else return getProperty(property);
			} else return property;
		};
	}
}

/** The transform for a `{ name, select?, sort?, offset?, limit? }` selector's value; `targetResource` supplies resolvers. */
export function nestedSelectTransform(property: any, targetResource?: any): (value: any) => any {
	const subSelect = property.select ?? (Array.isArray(property) ? property : null);
	const innerTransform =
		subSelect &&
		!(subSelect.length === 1 && subSelect[0] === '*' && !subSelect.asArray && !subSelect[RELATIONSHIPS_LISTED])
			? transformForSelect(subSelect, targetResource)
			: (value) => value;
	const sortClauses: { attribute: string | string[]; descending?: boolean }[] = [];
	for (let clause = typeof property.sort === 'object' ? property.sort : null; clause; clause = clause.next) {
		sortClauses.push(clause);
	}
	const offset = Number.isInteger(property.offset) && property.offset >= 0 ? property.offset : undefined;
	const limit = Number.isInteger(property.limit) && property.limit >= 0 ? property.limit : undefined;
	if (sortClauses.length === 0 && offset === undefined && limit === undefined) return innerTransform;
	return (value) =>
		innerTransform(Array.isArray(value) ? sortAndSliceArray(value, sortClauses, offset, limit, targetResource) : value);
}

export function sortAndSliceArray(
	resolvedValue: any[],
	sortClauses: { attribute: string | string[]; descending?: boolean }[],
	offset: number | undefined,
	limit: number | undefined,
	targetResource?: any,
	context?: any
): any[] {
	let ordered = resolvedValue;
	const clauseCount = sortClauses.length;
	if (clauseCount > 0 && resolvedValue.length > 1) {
		const resolvers = targetResource?.propertyResolvers;
		const ctx = context ?? targetResource?.getContext?.();
		const n = resolvedValue.length;
		const orderedKeys: any[][] = new Array(clauseCount);
		for (let c = 0; c < clauseCount; c++) {
			const attr = sortClauses[c].attribute;
			const col = new Array(n);
			for (let i = 0; i < n; i++) {
				col[i] = getComparableKey(resolvedValue[i], attr, resolvers, ctx);
			}
			orderedKeys[c] = col;
		}
		const positions = new Array<number>(n);
		for (let i = 0; i < n; i++) positions[i] = i;
		positions.sort((posA, posB) => {
			for (let c = 0; c < clauseCount; c++) {
				const keys = orderedKeys[c];
				const diff = sortClauses[c].descending
					? compareKeys(keys[posB], keys[posA])
					: compareKeys(keys[posA], keys[posB]);
				if (diff !== 0) return diff;
			}
			return 0;
		});
		ordered = new Array(n);
		for (let i = 0; i < n; i++) ordered[i] = resolvedValue[positions[i]];
	}
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 0;
		ordered = ordered.slice(start, limit !== undefined ? start + limit : undefined);
	}
	return ordered;
}

export function convertToComparableKeys(value) {
	if (value instanceof Date) return value.getTime();
	if (Array.isArray(value)) return value.map(convertToComparableKeys);
	return value;
}

function readPropertyFromObject(object, property, propertyResolvers, context, selectsPrototype: boolean) {
	const record = typeof object.getRecord === 'function' ? object.getRecord() : undefined;
	let value, resolver;
	if (record) {
		if (Object.hasOwn(object, property) && typeof (value = object[property]) !== 'function') {
			return value;
		}
		const ownData = object.getChanges?.();
		if (ownData && Object.hasOwn(ownData, property)) {
			value = selectsPrototype ? readSelectedProperty(ownData, property) : ownData[property];
			return typeof value === 'function' ? undefined : value;
		}
	}
	if (propertyResolvers && Object.hasOwn(propertyResolvers, property) && (resolver = propertyResolvers[property])) {
		return resolver(object, context);
	}
	const source = record ?? object;
	value = selectsPrototype ? readSelectedProperty(source, property) : source[property];
	return typeof value === 'function' ? undefined : value;
}

function getComparableKey(item, attribute, resolvers, ctx) {
	if (item == null || typeof item !== 'object') return undefined;
	if (Array.isArray(attribute)) {
		let value = item;
		let currentResolvers = resolvers;
		for (const part of attribute) {
			if (value == null || typeof value !== 'object') return undefined;
			value = readPropertyFromObject(value, part, currentResolvers, ctx, part === '__proto__');
			currentResolvers =
				currentResolvers && Object.hasOwn(currentResolvers, part)
					? (currentResolvers[part]?.definition || currentResolvers[part]?.elements?.definition)?.tableClass
							?.propertyResolvers
					: undefined;
		}
		return convertToComparableKeys(value);
	}
	return convertToComparableKeys(readPropertyFromObject(item, attribute, resolvers, ctx, attribute === '__proto__'));
}
