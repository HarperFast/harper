export interface Resource<Key = any, Record = any> {
	get(key: Key, options): Record;
	put(record: Record, options): Promise<any>;
	delete(key: Key, options): Promise<any>;
	search(query, options): Iterable<any>;
	subscribe(query, options): Subscription;
}
interface Subscription {}