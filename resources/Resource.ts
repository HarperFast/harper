export interface Resource<Key = any, Record = any> {
	get?(key: Key, options): Record; // or use ResourceId instead of Key
	put?(record: Record, options): Promise<any>;
	delete?(key: Key, options): Promise<any>;
	search?(query, options): Iterable<any>;
	subscribe?(query, options): Subscription;
	lastAccessTime: number
}
interface Subscription {}
type ResourceId = Request|number|string;