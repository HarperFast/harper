export interface ResourceInterface<Key = any, Record = any> {
	get?(request: Request): Promise<UpdatableRecord<Record>>;
	get?(query: Query): Promise<AsyncIterable<Record>>;
	get?(property: string): any;
	put?(record: any, request: Request): void;
	update?(updates: any, request: Request): Promise<UpdatableRecord<Record>>;
	delete?(request: Request): boolean;
	search?(query: Query): AsyncIterable<any>;
	subscribe?(request: SubscriptionRequest): Subscription;
	allowRead(request: Request): boolean | Promise<boolean>;
	allowUpdate(updates: any, request: Request): boolean | Promise<boolean>;
	allowCreate(record: any, request: Request): boolean | Promise<boolean>;
	allowDelete(request: Request): boolean | Promise<boolean>;
	lastModificationTime: number;
	request: Request;
}
export interface Context {
	user?: any;
	transactions: any[];
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
type UpdatableRecord<T> = T
interface Subscription {}
type ResourceId = Request|number|string;