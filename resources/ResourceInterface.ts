import type { User } from '../security/user.ts';
import type { OperationFunctionName } from '../server/serverHelpers/serverUtilities.ts';
import { DatabaseTransaction } from './DatabaseTransaction.ts';
import { IterableEventQueue } from './IterableEventQueue.ts';
import type { Entry, RecordObject } from './RecordEncoder.ts';
import { RequestTarget } from './RequestTarget.ts';

export interface ResourceInterface<Record extends object = any>
	extends Partial<RecordObject>, Pick<UpdatableRecord<Record>, 'addTo' | 'subtractFrom'> {
	allowRead(user: User, target: RequestTarget, context: Context): boolean | Promise<boolean>;
	get?(
		target?: RequestTargetOrId
	):
		| (Record & Partial<RecordObject>)
		| Promise<Record & Partial<RecordObject>>
		| AsyncIterable<Record & Partial<RecordObject>>
		| Promise<AsyncIterable<Record & Partial<RecordObject>>>;
	search?(target: RequestTarget): AsyncIterable<Record & Partial<RecordObject>>;

	allowCreate(user: User, record: Promise<Record & RecordObject>, context: Context): boolean | Promise<boolean>;
	create?(
		newRecord: Partial<Record & RecordObject>,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<Record & Partial<RecordObject>>;
	post?(
		target: RequestTargetOrId,
		newRecord: Partial<Record & RecordObject>
	): void | (Record & Partial<RecordObject>) | Promise<Record & Partial<RecordObject>>;

	allowUpdate(user: User, record: Promise<Record & RecordObject>, context: Context): boolean | Promise<boolean>;
	put?(
		record: Record & RecordObject,
		target?: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;
	patch?(
		record: Partial<Record & RecordObject>,
		target: RequestTargetOrId
	): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)>;
	update?(updates: Record & RecordObject, fullUpdate: true): ResourceInterface<Record & Partial<RecordObject>>;
	update?(
		updates: Partial<Record & RecordObject>,
		fullUpdate?: boolean
	):
		| ResourceInterface<Record & Partial<RecordObject>>
		| Promise<ResourceInterface<Record & Partial<RecordObject>> | UpdatableRecord<Record & Partial<RecordObject>>>;

	allowDelete(user: User, target: RequestTarget, context: Context): boolean | Promise<boolean>;
	delete?(target: RequestTargetOrId): boolean | Promise<boolean>;

	invalidate(target: RequestTargetOrId): void | Promise<void>;

	publish?(target: RequestTargetOrId, record: Record, options?: any): void;
	subscribe?(request: SubscriptionRequest): AsyncIterable<Record> | Promise<AsyncIterable<Record>>;

	doesExist(): boolean;
	wasLoadedFromSource(): boolean | void;

	getCurrentUser(): User | undefined;
}

export interface Session {
	id?: any;
	user?: User;
	update: (updatedSession: any) => unknown;
	delete: (id: any) => Promise<void>;
}

export interface Context {
	/**	 The user making the request */
	user?: User;
	/** Check the username and password against the core user table to verify user identity */
	login: (username: string, password: string) => Promise<string>;
	/** Describes the current cookie-based session if it is present and grants the capacity to delete it. authentication.enableSessions must be turned on in the harperdb-config.yaml  */
	session?: Session;
	/**	 The database transaction object */
	transaction?: DatabaseTransaction;
	/**	 If the operation that will be performed with this context should check user authorization	 */
	authorize?: boolean;
	/**	 The last modification time of any data that has been accessed with this context	 */
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
	timestamp?: number;
}

export interface SourceContext<TRequestContext = Context, Record extends object = any> {
	/** The original request context passed from the caching layer */
	requestContext: TRequestContext;
	/** The existing record, from the existing entry (if any) */
	replacingRecord?: Record;
	/** The existing database entry (if any) */
	replacingEntry?: Entry;
	/** The version/timestamp of the existing record */
	replacingVersion?: number;
	/** Indicates that values from the source data should NOT be stored as a cached value */
	noCacheStore?: boolean;
	/** Reference to the source Resource instance */
	source?: ResourceInterface<Record>;
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

export type Comparator =
	| 'between'
	| 'contains'
	| 'ends_with'
	| 'eq'
	| 'equals'
	| 'greater_than'
	| 'greater_than_equal'
	| 'less_than'
	| 'less_than_equal'
	| 'ne'
	| 'not_equal'
	| 'starts_with';

export type DirectCondition<Record extends object = any> = TypedDirectCondition<Record, keyof Record>;

interface TypedDirectCondition<Record extends object, Property extends keyof Record> {
	attribute?: keyof Record | Array<keyof Record> | string | string[];
	search_attribute?: keyof Record | Array<keyof Record> | string | string[];
	comparator?: Comparator;
	search_type?: Comparator;
	value?: Record[Property];
	search_value?: Record[Property];
}

interface ConditionGroup<Record extends object = any> {
	conditions?: Conditions<Record>;
	operator?: Operator;
}
export type Condition<Record extends object = any> = DirectCondition<Record> & ConditionGroup<Record>;
export type Conditions<Record extends object = any> = Condition<Record>[];

export interface Sort<Record extends object = any> {
	attribute: keyof Record;
	descending?: boolean;
	next?: Sort<Record>;
}
export interface SubSelect {
	name: string;
	select: (string | SubSelect)[];
}
export type Select = (string | SubSelect)[];

export interface SubscriptionRequest extends RequestTarget {
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
	listener?: Listener;
}

export type Query = RequestTarget; // for back-compat
export type RequestTargetOrId = RequestTarget | Id;

export type Id = number | string | (number | string | null)[] | null;

export type UpdatableRecord<Record extends object = any> = TypedUpdatableRecord<Record, keyof Record>;
interface TypedUpdatableRecord<Record extends object, Property extends keyof Record> extends RecordObject {
	set(property: Property, value: Record[Property]): void;
	getProperty(property: Property): Record[Property];
	addTo(property: Property, value: Record[Property]): void;
	subtractFrom(property: Property, value: Record[Property]): void;
}

export interface Subscription<Event extends object = any> extends IterableEventQueue<Event> {
	new (listener: Listener<Event>);

	listener: Listener<Event>;
	subscriptions: Listener<Event>[];
	startTime?: number;

	end(): void;
	toJSON(): { name: 'subscription' };
}

type Listener<Payload extends object = any> = (payload: ListenerPayload<Payload>) => void;

interface ListenerPayload<Payload extends object = any> {
	id: Id;
	localTime: number;
	value: Payload;
	version: number;
	type: string;
	beginTxn: boolean;
}
