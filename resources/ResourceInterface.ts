export interface ResourceInterface<Key = any, Record = any> {
	get?(key: Key, options?: {}): Promise<UpdatableRecord<Record>>; // or use ResourceId instead of Key
	put?(key: Key, record: Record, options?: {}): void;
	patch?(key: Key, record: Record, options?: {}): Record;
	delete?(key: Key, options?: {}): boolean;
	search?(query, options?: {}): AsyncIterable<any>;
	subscribe?(query, options?: {}): Subscription;
	lastAccessTime: number
}
type UpdatableRecord<T> = T & {
	lock(): Promise<T>;
	save(): void;
	update: T
}
interface Subscription {}
type ResourceId = Request|number|string;