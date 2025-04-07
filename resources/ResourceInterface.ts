import { DatabaseTransaction } from './DatabaseTransaction';
import { OperationFunctionName } from '../server/serverHelpers/serverUtilities';

export interface ResourceInterface<Key = any, Record = any> {
	get?(): Promise<UpdatableRecord<Record>>;
	get?(query: Query): Promise<AsyncIterable<Record>>;
	get?(property: string): any;
	put?(record: any): void;
	update?(updates: any, full_update?: boolean): Promise<UpdatableRecord<Record>>;
	delete?(): boolean;
	search?(query: Query): AsyncIterable<any>;
	subscribe?(request: SubscriptionRequest): Subscription;
	allowRead(user: any, query?: Query, context: Context): boolean | Promise<boolean>;
	allowUpdate(user: any, record: any, full_update?: boolean): boolean | Promise<boolean>;
	allowCreate(user: any, record: any, context: Context): boolean | Promise<boolean>;
	allowDelete(user: any, query: Query, context: Context): boolean | Promise<boolean>;
}

export interface User {
	username: string;
}

export interface Context {
	/**	 The user making the request	 */
	user?: User;
	/**	 The database transaction object	 */
	transaction?: DatabaseTransaction;
	/**	 If the operation that will be performed with this context should check user authorization	 */
	authorize?: number;
	/**	 The last modification time of any data that has been accessed with this context	 */
	lastModified?: number;
	/**	 The time	at which a saved record should expire */
	expiresAt?: number;
	/**	 Indicates that caching should not be applied	 */
	noCache?: boolean;
	/**	 Indicates that values from the source data should be stored as a cached value	 */
	noCacheStore?: boolean;
	/**	 Only return values from the table, and don't use data from the source */
	onlyIfCached?: boolean;
	/**	 Allows data from a caching table to be used if there is an error retrieving data from the source */
	staleIfError?: boolean;
	/**	 Indicates any cached data must be revalidated	 */
	mustRevalidate?: boolean;
	/**	 An array of nodes to replicate to */
	replicateTo?: string[];
	replicateFrom?: boolean;
	replicatedConfirmation?: number;
	originatingOperation?: OperationFunctionName;
}

export type Operator = 'and' | 'or';

type SearchType =
	| 'equals'
	| 'contains'
	| 'starts_with'
	| 'ends_with'
	| 'greater_than'
	| 'greater_than_equal'
	| 'less_than'
	| 'less_than_equal'
	| 'between';

export interface DirectCondition {
	attribute?: string;
	search_attribute?: string;
	comparator?: SearchType;
	search_type?: SearchType;
	value?: any;
	search_value?: any;
}
interface ConditionGroup {
	conditions: Conditions;
	operator?: Operator;
}
export type Condition = DirectCondition | ConditionGroup;
export type Conditions = Condition[];

export interface Sort {
	attribute: string;
	descending?: boolean;
	next?: Sort;
}
export interface SubSelect {
	name: string;
	select: (string | SubSelect)[];
}
export type Select = (string | SubSelect)[];
export interface Query {
	/** Retrieve a specific record, but can be combined with select */
	id?: Id;
	/**	 The conditions to use in the query, that the returned records must satisfy	 */
	conditions?: Conditions;
	/**	 The number of records to return	 */
	limit?: number;
	/**	 The number of records to skip	 */
	offset?: number;
	/**	 The number of operator to use*/
	operator?: 'AND' | 'OR';
	/**	 The sort attribute and direction to use */
	sort?: Sort;
	/**	 The selected attributes to return	 */
	select?: Select;
	/**	 Return an explanation of the query order */
	explain?: boolean;
	/**	 Force the query to be executed in the order of conditions */
	enforceExecutionOrder?: boolean;
	lazy?: boolean;
}
export interface SubscriptionRequest {
	/** The starting time of events to return (defaults to now) */
	startTime?: number;
	/** The count of previously recorded events to return */
	previousCount?: number;
	/** If the current record state should be omitted as the first event */
	omitCurrent?: boolean;
}
export type Id = number | string | (number | string | null)[] | null;
type UpdatableRecord<T> = T;
interface Subscription {}
type ResourceId = Request | number | string;
