import { DatabaseTransaction } from './DatabaseTransaction.ts';
import type { OperationFunctionName } from '../server/serverHelpers/serverUtilities.ts';
import { RequestTarget } from './RequestTarget.ts';
import type { Entry } from './RecordEncoder.ts';

export interface ResourceInterface<Key = any, Record = any> {
	get?(id: Id): Promise<Record>;
	get?(query: RequestTargetOrId): Promise<AsyncIterable<Record>>;
	put?(target: RequestTargetOrId, record: any): void;
	post?(target: RequestTargetOrId, record: any): void;
	patch?(target: RequestTargetOrId, record: any): void;
	publish?(target: RequestTargetOrId, record: any): void;
	update?(updates: any, fullUpdate?: boolean): Promise<UpdatableRecord<Record>>;
	delete?(target: RequestTargetOrId): boolean;
	search?(query: RequestTarget): AsyncIterable<any>;
	subscribe?(request: SubscriptionRequest): Subscription;
	allowRead(user: any, target: RequestTarget): boolean | Promise<boolean>;
	allowUpdate(user: any, record: any, target: RequestTarget): boolean | Promise<boolean>;
	allowCreate(user: any, record: any, target: RequestTarget): boolean | Promise<boolean>;
	allowDelete(user: any, target: RequestTarget): boolean | Promise<boolean>;
}

export interface User {
	username: string;
}

export interface Context {
	/**	 The user making the request */
	user?: User;
	/**	 The database transaction object */
	transaction?: DatabaseTransaction;
	/**	 If the operation that will be performed with this context should check user authorization */
	authorize?: number;
	/**	 The last modification time of any data that has been accessed with this context */
	lastModified?: number;
	/**	 The time	at which a saved record should expire */
	expiresAt?: number;
	/**	 Indicates that caching should not be applied */
	noCache?: boolean;
	/**	 Indicates that values from the source data should be stored as a cached value */
	noCacheStore?: boolean;
	/**	 Only return values from the table, and don't use data from the source */
	onlyIfCached?: boolean;
	/**	 Allows data from a caching table to be used if there is an error retrieving data from the source */
	staleIfError?: boolean;
	/**	 Indicates any cached data must be revalidated */
	mustRevalidate?: boolean;
	/**	 An array of nodes to replicate to */
	replicateTo?: string[];
	replicateFrom?: boolean;
	replicatedConfirmation?: number;
	originatingOperation?: OperationFunctionName;
	previousResidency?: string[];
	loadedFromSource?: boolean;
	nodeName?: string;
	resourceCache?: Map<Id, any>;
	_freezeRecords?: boolean; // until v5, we conditionally freeze records for back-compat
}

export interface SourceContext<TRequestContext = Context> {
	/** The original request context passed from the caching layer */
	requestContext: TRequestContext;
	/** The existing record, from the existing entry (if any) */
	replacingRecord?: any;
	/** The existing database entry (if any) */
	replacingEntry?: Entry;
	/** The version/timestamp of the existing record */
	replacingVersion?: number;
	/** Indicates that values from the source data should NOT be stored as a cached value */
	noCacheStore?: boolean;
	/** Reference to the source Resource instance */
	source?: ResourceInterface;
	/** Shared resource cache from parent context for visibility of modifications */
	resourceCache?: Map<Id, any>;
	/** Database transaction for the context */
	transaction?: DatabaseTransaction;
	/** The time at which the cached entry should expire (ms since epoch) */
	expiresAt?: number;
	/** The last modification time of any data accessed with this context */
	lastModified?: number;
}

export type Operator = 'and' | 'or';

type Comparator =
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
	comparator?: Comparator;
	search_type?: Comparator;
	value?: any;
	search_value?: any;
}
interface ConditionGroup {
	conditions?: Conditions;
	operator?: Operator;
}
export type Condition = DirectCondition & ConditionGroup;
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
export interface SubscriptionRequest {
	/** The starting time of events to return (defaults to now) */
	startTime?: number;
	/** The count of previously recorded events to return */
	previousCount?: number;
	/** If the current record state should be omitted as the first event */
	omitCurrent?: boolean;
	onlyChildren?: boolean;
	includeDescendants?: boolean;
	supportsTransactions?: boolean;
	rawEvents?: boolean;
	listener: (data: any) => void;
}
export type Query = RequestTarget; // for back-compat
export type RequestTargetOrId = RequestTarget | Id;

export type Id = number | string | (number | string | null)[] | null;
export type UpdatableRecord<T> = T;
interface Subscription {}
