import type { UserRoleDatabasePermissions } from '../security/user.ts';
import type { Conditions, DirectCondition, Id, Select, Sort } from './ResourceInterface.ts';
import { parseQuery } from './search.ts';

export class RequestTarget extends URLSearchParams {
	#target?: string;
	pathname: string;
	search?: string;
	/** Target a specific record, but can be combined with select */
	id?: Id;

	/** Request a specific property from the identified record */
	declare property?: string;

	/** Request best effort and returning synchronously */
	declare syncAllowed?: boolean;

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
	declare sort?: Sort = null;
	/**	 The selected attributes to return	 */
	declare select?: Select;
	/**	 Return an explanation of the query order */
	declare explain?: boolean;
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
	declare loadedFromSource?: boolean;
	declare createdNewId?: string;

	declare checkPermission?: UserRoleDatabasePermissions | boolean;
	declare subscribe?: boolean;

	declare allowFullScan?: boolean;
	declare allowConditionsOnDynamicAttributes?: boolean;

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
		} else {
			return; // leave this.id undefined
		}
		if (path) {
			if (path.endsWith('/')) {
				this.isCollection = true;
			}
			this.id = decodeURIComponent(path);
		} else {
			this.isCollection = true;
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
