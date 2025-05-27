import { Conditions, Id, Select, Sort } from './ResourceInterface';
import { _assignPackageExport } from '../globals';
import { Resource } from './Resource';

export class RequestTarget extends URLSearchParams {
	target?: string;
	pathname: string;
	search?: string;
	/** Target a specific record, but can be combined with select */
	id?: Id;

	/** Indicates that this is a request to query for collection of records */
	isCollection?: boolean;
	// these are query parameters
	/**	 The conditions to use in the query, that the returned records must satisfy	 */
	conditions?: Conditions;
	/**	 The number of records to return	 */
	limit?: number;
	/**	 The number of records to skip	 */
	offset?: number;
	/**	 The number of operator to use*/
	operator?: 'AND' | 'OR';
	/**	 The sort attribute and direction to use */
	/** @ts-ignore*/
	sort?: Sort = null; // USP has a sort method, we hide it
	/**	 The selected attributes to return	 */
	select?: Select;
	/**	 Return an explanation of the query order */
	explain?: boolean;
	/**	 Force the query to be executed in the order of conditions */
	enforceExecutionOrder?: boolean;
	lazy?: boolean;

	// caching directives
	noCacheStore?: boolean;
	noCache?: boolean;
	onlyIfCached?: boolean;
	staleIfError?: boolean;
	mustRevalidate?: boolean;

	// replication directives
	replicateTo?: string[];
	replicateFrom?: boolean;
	replicatedConfirmation?: number;
	originatingOperation?: string;
	previousResidency?: string[];

	authorize?: Permission | boolean;

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
		this.target = target;
	}
	toString() {
		if (this.size > 0) return this.pathname + '?' + super.toString();
		else return this.pathname;
	}
	get url() {
		// for back-compat?
		return this.toString();
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
