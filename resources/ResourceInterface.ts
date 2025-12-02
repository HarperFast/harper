import { User } from '../security/user.ts';
import type { OperationFunctionName } from '../server/serverHelpers/serverUtilities.ts';
import { DatabaseTransaction } from './DatabaseTransaction.ts';
import { IterableEventQueue } from './IterableEventQueue.js';
import type { Entry, RecordObject } from './RecordEncoder.ts';
import { RequestTarget } from './RequestTarget.ts';

export interface ResourceInterface<Record extends object = any>
	extends RecordObject, Pick<UpdatableRecord<Record>, 'addTo' | 'subtractFrom'> {
	new (identifier: Id, source: any);

	allowRead(user: User, target: RequestTarget): boolean | Promise<boolean>;
	get?(id: Id): Promise<Record & RecordObject>;
	get?(query: RequestTargetOrId): Promise<AsyncIterable<Record & RecordObject>>;
	search?(query: RequestTarget): AsyncIterable<Record & RecordObject>;

	allowCreate(user: User, record: Record & RecordObject, target: RequestTarget): boolean | Promise<boolean>;
	create?(target: RequestTargetOrId, record: Partial<Record & RecordObject>): void;
	post?(target: RequestTargetOrId, record: Partial<Record & RecordObject>): void;

	allowUpdate(user: User, record: Record & RecordObject, target: RequestTarget): boolean | Promise<boolean>;
	put?(target: RequestTargetOrId, record: Record & RecordObject): void;
	patch?(target: RequestTargetOrId, record: Partial<Record & RecordObject>): void;
	update?(updates: Record & RecordObject, fullUpdate: true): ResourceInterface<Record & RecordObject>;
	update?(
		updates: Partial<Record & RecordObject>,
		fullUpdate?: boolean
	):
		| ResourceInterface<Record & RecordObject>
		| Promise<ResourceInterface<Record & RecordObject> | UpdatableRecord<Record & RecordObject>>;

	allowDelete(user: User, target: RequestTarget): boolean | Promise<boolean>;
	delete?(target: RequestTargetOrId): boolean;
	invalidate(target: RequestTargetOrId): void | Promise<void>;

	publish?(target: RequestTargetOrId, record: Record): void;
	subscribe?(request: SubscriptionRequest): Promise<Subscription<Record & RecordObject>>;

	doesExist(): boolean;
	wasLoadedFromSource(): boolean | void;
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
	listener: Listener;
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

interface Subscription<Event extends object = any> extends IterableEventQueue<Event> {
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
