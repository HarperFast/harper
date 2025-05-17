import { Conditions, Id, Select, Sort } from './ResourceInterface';

export class RequestTarget extends URLSearchParams {
	declare target?: string;
	declare pathname: string;
	declare search?: string;
	/** Target a specific record, but can be combined with select */
	declare id?: Id;
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
	sort?: Sort = null; // USP has a sort method, we hide it
	/**	 The selected attributes to return	 */
	declare select?: Select;
	/**	 Return an explanation of the query order */
	declare explain?: boolean;
	/**	 Force the query to be executed in the order of conditions */
	declare enforceExecutionOrder?: boolean;
	declare lazy?: boolean;
	constructor(target?: string) {
		const searchIndex = target?.indexOf('?');
		let path: string | undefined;
		if ((searchIndex as number) > -1) {
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
