export interface ResourceInterface<Key = any, Record = any> {
	get?(request: Request): Promise<UpdatableRecord<Record>>; // or use ResourceId instead of Key
	put?(request: Request): void;
	patch?(request: Request): Record;
	update?(request: Request): Promise<UpdatableRecord<Record>>;
	delete?(request: Request): boolean;
	search?(request: Request): AsyncIterable<any>;
	subscribe?(request: SubscriptionRequest): Subscription;
	allowRead(request: Request): boolean | Promise<boolean>;
	allowUpdate(request: Request): boolean | Promise<boolean>;
	allowCreate(request: Request): boolean | Promise<boolean>;
	allowDelete(request: Request): boolean | Promise<boolean>;
	lastModificationTime: number;
	request: Request;
}
export interface Request {
	id: Id;
	path: string;
	user: any;
	data?: any;
	select?: string[];
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