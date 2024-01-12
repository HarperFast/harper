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
	user?: any;
	transaction: DatabaseTransaction;
	responseData: {
		lastModified: number;
	};
}
export interface Request {
	id?: Id;
	path?: string;
	user?: any;
	data?: any;
	select?: string[];
	context?: Context;
}
export interface Query extends Request {
	conditions?: any[];
	limit?: number;
	offset?: number;
}
export interface SubscriptionRequest extends Request {
	startTime?: number;
	previousCount?: number;
}
export type Id = number | string | (number | string | null)[] | null;
type UpdatableRecord<T> = T;
interface Subscription {}
type ResourceId = Request | number | string;
