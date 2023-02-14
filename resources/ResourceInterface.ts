export interface ResourceInterface<Key = any, Record = any> {
	get?(key: Key, options?: {}): Promise<UpdatableRecord<Record>>; // or use ResourceId instead of Key
	put?(key: Key, record: Record, options?: {}): void;
	patch?(key: Key, record: Record, options?: {}): Record;
	update?(key: Key): Promise<UpdatableRecord<Record>>;
	delete?(key: Key, options?: {}): boolean;
	search?(query, options?: {}): AsyncIterable<any>;
	subscribe?(query, options?: {}): Subscription;
	allowAccess(): boolean | Promise<boolean>;
	allowGet(): boolean | Promise<boolean>;
	allowPut(): boolean | Promise<boolean>;
	allowPatch(): boolean | Promise<boolean>;
	allowDelete(): boolean | Promise<boolean>;
	lastModificationTime: number;
}
type UpdatableRecord<T> = T
interface Subscription {}
type ResourceId = Request|number|string;