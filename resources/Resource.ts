export interface Resource<Key = any, Record = any> {
	get?(key: Key, options?: {}): Promise<Record>; // or use ResourceId instead of Key
	put?(key: Key, record: Record, options?: {}): void;
	patch?(key: Key, record: Record, options?: {}): Record;
	delete?(key: Key, options?: {}): boolean;
	search?(query, options?: {}): AsyncIterable<any>;
	subscribe?(query, options?: {}): Subscription;
	lastAccessTime: number
}
interface Subscription {}
type ResourceId = Request|number|string;