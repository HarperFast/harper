import { Conditions, DirectCondition, Id, Select, Sort } from './ResourceInterface';
import { _assignPackageExport } from '../globals';
import { Resource } from './Resource';

export class RequestTarget extends URLSearchParams {
	#target?: string;
	pathname: string;
	search?: string;
	/** Target a specific record, but can be combined with select */
	id?: Id;

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
	/** @ts-ignore*/
	declare sort?: Sort = null; // USP has a sort method, we hide it
	/**	 The selected attributes to return	 */
	declare select?: Select;
	/**	 Return an explanation of the query order */
	declare explain?: boolean;
	/**	 Force the query to be executed in the order of conditions */
	declare enforceExecutionOrder?: boolean;
	declare lazy?: boolean;

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

	declare checkPermission?: Permission | boolean;

	constructor(target?: string) {
		let searchIndex: number | undefined;
		let path: string | undefined;
		if (target && (searchIndex = target.indexOf('?')) > -1) {
			path = (target as string).slice(0, searchIndex);
			const search = (target as string).slice((searchIndex as number) + 1);
			super(search);
			this.search = search;
		} else {
			super();
			path = target;
		}
		this.pathname = path ?? '';
		this.#target = target;
	}
	toString() {
		if (this.#target) return this.#target;
		if (this.size > 0) return this.pathname + '?' + super.toString();
		else return this.pathname;
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
		if (this.conditions) {
			this.conditions.push({ attribute: name, value });
		}
	}
	append(name: string, value: string) {
		super.append(name, value);
		this.#target = undefined; // remove this so that we can regenerate string representation based on query params
		if (this.conditions) {
			this.conditions.push({ attribute: name, value });
		}
	}
}
export type RequestTargetOrId = RequestTarget | Id;
_assignPackageExport('Resource', Resource);

interface Permission {
	read: boolean;
	update: boolean;
	delete: boolean;
	insert: boolean;

	[database: string]:
		| boolean
		| {
				read: boolean;
				update: boolean;
				delete: boolean;
				insert: boolean;
				tables: {
					[table: string]: {
						read: boolean;
						update: boolean;
						delete: boolean;
						insert: boolean;
						attribute_permissions: {
							attribute_name: string;
							read: boolean;
							update: boolean;
							delete: boolean;
						}[];
					};
				};
		  };
}
