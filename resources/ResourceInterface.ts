import { DatabaseTransaction } from './DatabaseTransaction';

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
export interface Context {
	/**	 The user making the request	 */
	user?: any;
	/**	 The database transaction object	 */
	transaction: DatabaseTransaction;
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
}
export interface DirectCondition {
	attribute: string;
	comparator?: string;
	value: any;
}
interface ConditionGroup {
	conditions: Condition[];
	operator?: string;
}
export type Condition = DirectCondition | ConditionGroup;
export interface Sort {
	attribute: string;
	descending?: boolean;
	next?: Sort;
}
export interface SubSelect {
	name: string;
	select: (string | SubSelect)[];
}
export interface Query {
	/** Retrieve a specific record, but can be combined with select */
	id?: Id;
	/**	 The conditions to use in the query, that the returned records must satisfy	 */
	conditions?: Condition[];
	/**	 The number of records to return	 */
	limit?: number;
	/**	 The number of records to skip	 */
	offset?: number;
	/**	 The number of operator to use*/
	operator?: 'AND' | 'OR';
	/**	 The sort attribute and direction to use */
	sort?: Sort;
	/**	 The selected attributes to return	 */
	select?: (string | SubSelect)[];
	/**	 Return an explanation of the query order */
	explain?: boolean;
	/**	 Force the query to be executed in the order of conditions */
	enforceExecutionOrder?: boolean;
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
