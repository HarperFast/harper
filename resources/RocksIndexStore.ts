import {
	DBI,
	type StoreIteratorOptions,
	type StorePutOptions,
	type StoreRemoveOptions,
	RocksDatabase,
} from '@harperfast/rocksdb-js';
import { Id } from './ResourceInterface.ts';
import { compareKeys, MAXIMUM_KEY } from 'ordered-binary';
import { ExtendedIterable } from '@harperfast/extended-iterable';

function cloneKey(key: any): any {
	if (Array.isArray(key)) return key.map(cloneKey);
	if (key instanceof Uint8Array) return key.slice();
	return key;
}

declare module '@harperfast/rocksdb-js' {
	interface DBI<T> {
		getValuesCount(indexedValue: any): number;
	}
}

/**
 * A specialized RocksDB-based index store that maintains indexed references to primary keys.
 * This store uses composite keys consisting of indexed values and primary keys, enabling
 * efficient range queries over indexed data. The actual data values are stored as null since
 * this is purely an index structure pointing to primary records elsewhere. This extends
 * RocksDatabase rather than a store because it actually alters the interface
 */
export class RocksIndexStore extends RocksDatabase {
	/**
	 * Get all entries matching the range
	 * @param options
	 */
	getRange(options: StoreIteratorOptions): Iterable<any> {
		let { start, end, exclusiveStart, inclusiveEnd, reverse } = options;
		if ((reverse ? !exclusiveStart : exclusiveStart) && start !== undefined) {
			start = [start, MAXIMUM_KEY];
		}
		if ((reverse ? !inclusiveEnd : inclusiveEnd) && end !== undefined) {
			end = [end, MAXIMUM_KEY];
		}
		const translatedOptions: StoreIteratorOptions & { offset?: number } = { ...options, start, end };
		if (options.values === false) {
			const { limit, offset = 0, ...keyOptions } = translatedOptions;
			const getKeys = () => super.getKeys(keyOptions);
			return new ExtendedIterable({
				*[Symbol.iterator]() {
					if (limit !== undefined && limit <= 0) return;
					let first = true;
					let previous: any;
					let skipped = 0;
					let yielded = 0;
					for (const key of getKeys()) {
						const indexedValue = key[0];
						if (!first && compareKeys(previous, indexedValue) === 0) continue;
						first = false;
						previous = cloneKey(indexedValue);
						if (skipped < Math.max(0, offset)) {
							skipped++;
							continue;
						}
						yield cloneKey(indexedValue);
						yielded++;
						if (limit !== undefined && yielded >= limit) return;
					}
				},
			});
		}
		return super.getRange(translatedOptions).map(({ key }) => {
			return { key: key[0], value: key.length > 2 ? key.slice(1) : key[1] };
		});
	}

	getCompositeRange(options: { after?: any[]; end: any; limit: number }): Iterable<{
		key: any;
		value: Id;
		cursor: any[];
	}> {
		const keyOptions: StoreIteratorOptions & { snapshot?: boolean } = {
			start: options.after ?? true,
			end: [options.end, MAXIMUM_KEY],
			limit: options.limit,
			snapshot: false,
			...(options.after === undefined ? {} : { exclusiveStart: true }),
		};
		return super.getKeys(keyOptions).map((key) => {
			const cursor = cloneKey(key) as any[];
			return {
				key: cursor[0],
				value: cursor.length > 2 ? cursor.slice(1) : cursor[1],
				cursor,
			};
		});
	}

	getValues(indexedValue: any, options: Omit<StoreIteratorOptions, 'start' | 'end'> = {}): Iterable<Id> {
		const {
			limit,
			offset = 0,
			...keyOptions
		} = options as Omit<StoreIteratorOptions, 'start' | 'end'> & {
			offset?: number;
		};
		const bounds = keyOptions.reverse
			? { start: [indexedValue, MAXIMUM_KEY], end: [indexedValue], inclusiveEnd: true }
			: { start: [indexedValue], end: [indexedValue, MAXIMUM_KEY] };
		const primaryKey = (key: any[]) => (key.length > 2 ? key.slice(1).map(cloneKey) : cloneKey(key[1]));
		if (Math.max(0, offset) === 0 && (limit === undefined || limit > 0)) {
			return super.getKeys({ ...keyOptions, ...bounds, limit }).map(primaryKey);
		}
		const getKeys = () => super.getKeys({ ...keyOptions, ...bounds });
		return new ExtendedIterable({
			*[Symbol.iterator]() {
				if (limit !== undefined && limit <= 0) return;
				let skipped = 0;
				let yielded = 0;
				for (const key of getKeys()) {
					if (skipped < Math.max(0, offset)) {
						skipped++;
						continue;
					}
					yield primaryKey(key);
					yielded++;
					if (limit !== undefined && yielded >= limit) return;
				}
			},
		});
	}

	/**
	 * Translate a put with indexed value and primary key to an underlying put
	 * @param indexedValue - ignored, only used by LMDB
	 * @param primaryKey
	 * @param txnId
	 */
	// @ts-ignore
	put(indexedValue: any, primaryKey: Id, options: StorePutOptions) {
		return super.putSync([indexedValue, primaryKey], null, options);
	}

	putSync(indexedValue: any, primaryKey: Id, options: StorePutOptions) {
		return super.putSync([indexedValue, primaryKey], null, options);
	}

	// @ts-ignore
	remove(indexedValue: any, primaryKey: Id, options?: StoreRemoveOptions) {
		return super.removeSync([indexedValue, primaryKey], options);
	}

	// @ts-ignore
	removeSync(indexedValue: any, primaryKey: Id, options?: StoreRemoveOptions) {
		super.removeSync([indexedValue, primaryKey], options);
	}
}

/**
 * Add `getValuesCount` to the DBI prototype which is used by the `RocksDatabase` and `Transaction`
 * classes.
 */
DBI.prototype.getValuesCount = function getValuesCount(indexedValue: any) {
	if (this instanceof RocksIndexStore) {
		return this.store.getCount(this._context, { start: [indexedValue], end: [indexedValue, MAXIMUM_KEY] });
	}
	throw new Error('getValuesCount is only supported if dupSort=true');
};
