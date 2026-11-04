import type { UserRoleDatabasePermissions } from '../security/user.ts';
import type { Conditions, Context, DirectCondition, Id, Select, Sort } from './ResourceInterface.ts';
import { parseQuery } from './search.ts';
import { ServerError } from '../utility/errors/hdbError.ts';

export const AUTHORIZATION_SELECT = Symbol.for('harper.authorizationSelect');

export let markDispatchTarget: (target: RequestTarget) => RequestTarget;
let isDispatchTarget: (target: any) => boolean;
let copyRequestTarget: (source: RequestTarget) => RequestTarget;

// Reusing a caller-owned query must not lose predicates when its iterator has already been consumed.
const iteratorSnapshots = new WeakMap<object, { values?: any[]; error?: unknown }>();

function replayIterator(source: any): Iterator<any> {
	let snapshot = iteratorSnapshots.get(source);
	if (!snapshot) {
		const iterator = source[Symbol.iterator]();
		if (iterator !== source) return iterator;
		snapshot = {};
		iteratorSnapshots.set(source, snapshot);
		try {
			snapshot.values = Array.from(iterator);
		} catch (error) {
			snapshot.error = error;
		}
	}
	if (Object.hasOwn(snapshot, 'error')) throw snapshot.error;
	return snapshot.values![Symbol.iterator]();
}

function copyConditions(value: any): any {
	return value && !Array.isArray(value) && typeof value[Symbol.iterator] === 'function'
		? { [Symbol.iterator]: () => replayIterator(value) }
		: value;
}

function copyQueryFields(source: any, stop = Object.prototype): PropertyDescriptorMap {
	const descriptors: PropertyDescriptorMap = Object.create(null);
	for (let object = source; object && object !== stop; object = Object.getPrototypeOf(object)) {
		for (const name of Reflect.ownKeys(object)) {
			if (Object.hasOwn(descriptors, name)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(object, name);
			if (!descriptor) continue;
			if ('value' in descriptor) {
				if (name === Symbol.iterator && typeof descriptor.value === 'function') {
					descriptors[name] = {
						value: () => replayIterator(source),
						writable: true,
						enumerable: descriptor.enumerable,
						configurable: true,
					};
					continue;
				}
				if (object !== source && typeof descriptor.value === 'function') continue;
				descriptors[name] = { ...descriptor, writable: true, configurable: true };
			} else {
				const materialize = (receiver: any, value: any) => {
					Object.defineProperty(receiver, name, {
						value: name === 'conditions' ? copyConditions(value) : value,
						writable: true,
						enumerable: descriptor.enumerable,
						configurable: true,
					});
					return value;
				};
				descriptors[name] = {
					get() {
						return materialize(this, Reflect.get(source, name, source));
					},
					set(value) {
						materialize(this, value);
					},
					enumerable: descriptor.enumerable,
					configurable: true,
				};
			}
		}
	}
	return descriptors;
}

export class RequestTarget extends URLSearchParams {
	#target?: string;
	#dispatchOwned?: boolean;
	static {
		markDispatchTarget = (target) => {
			target.#dispatchOwned = true;
			return target;
		};
		isDispatchTarget = (target) => #dispatchOwned in target && target.#dispatchOwned === true;
		copyRequestTarget = (source) => {
			const copy = new RequestTarget();
			for (const [name, value] of source) URLSearchParams.prototype.append.call(copy, name, value);
			copy.#target = source.#target;
			copy.#dispatchOwned = true;
			const prototype = Object.getPrototypeOf(source);
			Object.defineProperties(copy, copyQueryFields(source, RequestTarget.prototype));
			Object.setPrototypeOf(copy, prototype);
			return copy;
		};
	}
	pathname: string;
	search?: string;
	/** Target a specific record, but can be combined with select */
	id?: Id;

	/** Request a specific property from the identified record */
	declare property?: string;

	/** Request best effort and returning synchronously */
	declare syncAllowed?: boolean;

	declare sync?: boolean;

	/** Indicates that this is a request to query for collection of records */
	isCollection?: boolean;
	// these are query parameters
	// we `declare` these properties so we don't create them on every instance, as they are usually not present
	/**	 The conditions to use in the query, that the returned records must satisfy	 */
	declare conditions?: Conditions;
	/**	 The number of records to return	 */
	declare limit?: number;
	/**	 The number of records to skip	 */
	declare offset?: number;
	/**	 The number of operator to use*/
	declare operator?: 'AND' | 'OR';
	/**	 The sort attribute and direction to use */
	/** @ts-expect-error USP has a sort method, we hide it */
	sort?: Sort = null;
	/**	 The selected attributes to return	 */
	declare select?: Select;
	/**	 Return an explanation of the query order */
	declare explain?: boolean;
	/** Request a total count of matching records for pagination (REST `Prefer: count=exact|estimated`). */
	declare count?: 'exact' | 'estimated';
	/**	 Force the query to be executed in the order of conditions */
	declare enforceExecutionOrder?: boolean;
	declare lazy?: boolean;
	declare parseError?: Error;

	// caching directives
	declare noCacheStore?: boolean;
	declare noCache?: boolean;
	declare onlyIfCached?: boolean;
	declare staleIfError?: boolean;
	declare mustRevalidate?: boolean;

	// replication directives
	declare replicateTo?: string[];
	declare replicateFrom?: boolean;
	declare replicatedConfirmation?: number;
	declare originatingOperation?: string;
	declare previousResidency?: string[];

	// Action tracking
	/** Cache disposition of this get on a caching table: true if loaded from the source, false if
	 * served from cache. Set per-get; read it on the RequestTarget you passed to the get. */
	declare loadedFromSource?: boolean;
	declare createdNewId?: string;

	declare checkPermission?: UserRoleDatabasePermissions | boolean;
	declare subscribe?: boolean;

	declare allowFullScan?: boolean;
	declare allowConditionsOnDynamicAttributes?: boolean;

	/**
	 * Predicate-aware vector search (#1241). A `(record) => boolean` filter evaluated during HNSW
	 * traversal (and as a post-filter for other paths), so a vector sort keeps exploring until it has
	 * enough MATCHING nearest neighbors instead of post-filtering an under-filled candidate set. The
	 * function must be synchronous and side-effect free; the record it receives is frozen. JS-API only —
	 * never parsed from a REST query string (no eval of user-supplied code over HTTP).
	 */
	declare vectorFilter?: (record: any) => boolean;

	/**
	 * Application-supplied row predicate applied during query execution and against the final
	 * materialized record. JavaScript API only; never parsed from REST input. The predicate must be
	 * synchronous and side-effect free. Prefer adding indexed conditions when possible.
	 */
	declare rowFilter?: (record: any, context: Context) => boolean;

	/**
	 * When `false`, the query reads against the latest committed data without holding a consistent
	 * read snapshot open for the duration of the iteration. This trades read consistency (rows
	 * written after the scan starts may be observed) for not pinning a snapshot that blocks
	 * compaction and ties up resources — useful for long-running scans such as analytics queries.
	 * Defaults to `true` (a stable snapshot is held). Currently only honored by RocksDB-backed
	 * tables; see `DatabaseTransaction.getReadTxn`.
	 */
	declare snapshot?: boolean;

	constructor(target?: string) {
		let searchIndex: number | undefined;
		let path: string | undefined;
		if (target && (searchIndex = target.indexOf('?')) > -1) {
			// we have query parameters that need to be parsed
			path = (target as string).slice(0, searchIndex);
			const search = (target as string).slice((searchIndex as number) + 1);
			super(search);
			this.search = search;
			parseQuery(search, this);
			if (!path) {
				// if there is a query string, but no path, treat as a collection anyway
				this.isCollection = true;
				this.id = null;
				return;
			}
		} else {
			super();
			path = target;
		}
		this.pathname = path;
		this.#target = target;
		if (path) {
			// parse for properties and set the id
			if (path.startsWith('/')) path = path.substring(1);
		} else if (target === undefined) {
			return; // constructed with no target at all (internal use) — leave id/isCollection unset
		}
		if (path) {
			if (path.endsWith('/')) {
				this.isCollection = true;
			}
			this.id = path.includes('%') ? decodeURIComponent(path) : path;
		} else if (this.pathname === '/') {
			// a bare trailing slash is the documented way to address a resource's collection
			this.isCollection = true;
			this.id = null;
		} else {
			// an exact resource-path match with nothing left to parse and no trailing slash
			// (e.g. `/redirects` instead of the required `/redirects/`, harper#678): this is
			// neither a valid collection request nor a specific record, so id/isCollection must
			// still be well-defined (never left `undefined`) for dispatch to reject it cleanly
			// instead of letting downstream code assume one of them is always set.
			this.isCollection = false;
			this.id = null;
		}
	}
	toString() {
		if (this.#target) return this.#target;
		const path = this.pathname ?? this.id?.toString() ?? '';
		if (this.size > 0) return path + '?' + super.toString();
		else return path;
	}
	get url() {
		// for back-compat?
		return this.toString();
	}

	delete(name: string) {
		super.delete(name);
		if (this.conditions) {
			// remove any associated conditions (we may want to consider recursively going into nested conditions?)
			this.conditions = this.conditions.filter((condition: DirectCondition) => condition.attribute !== name);
		}
		this.#target = undefined; // remove this so that we can regenerate string representation based on query params
	}
	set(name: string, value: string) {
		this.delete(name); // clear out any existing conditions and #target
		super.set(name, value);
		this.conditions?.push({ attribute: name, value });
	}
	append(name: string, value: string) {
		super.append(name, value);
		this.#target = undefined; // remove this so that we can regenerate string representation based on query params
		this.conditions?.push({ attribute: name, value });
	}
}
export type RequestTargetOrId = RequestTarget | Id;

export function copyQueryTarget<T>(source: T): T {
	const copy = copyQueryTargetShell(source);
	const conditions = Object.getOwnPropertyDescriptor(copy, 'conditions');
	if (conditions && 'value' in conditions) (copy as any).conditions = copyConditions(conditions.value);
	return copy;
}

function copyQueryTargetShell<T>(source: T): T {
	if (source instanceof RequestTarget) return copyRequestTarget(source) as T;
	const prototype = Object.getPrototypeOf(source);
	if (source instanceof URLSearchParams) {
		const copy = new URLSearchParams(URLSearchParams.prototype.entries.call(source));
		Object.defineProperties(copy, copyQueryFields(source, URLSearchParams.prototype));
		return Object.setPrototypeOf(copy, prototype);
	}
	if (Array.isArray(source)) {
		const descriptors = copyQueryFields(source, Array.prototype);
		descriptors.length.configurable = false;
		return Object.setPrototypeOf(Object.defineProperties([], descriptors), prototype);
	}
	return Object.create(prototype, copyQueryFields(source));
}

/** Authorization writes only on a target this dispatch owns, so a caller's query object stays reusable. */
export function dispatchTarget<T>(target: T): T {
	if (isDispatchTarget(target)) return target;
	if ((target as any)[AUTHORIZATION_SELECT])
		throw new ServerError(
			'Can not authorize a query object that an earlier authorization already narrowed; pass a query object that has not been authorized'
		);
	return copyQueryTarget(target);
}
