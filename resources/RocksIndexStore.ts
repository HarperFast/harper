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
		const translatedOptions = { ...options, start, end };
		if (options.values === false) {
			const { limit, ...keyOptions } = translatedOptions;
			const getKeys = () => super.getKeys(keyOptions);
			return new ExtendedIterable({
				*[Symbol.iterator]() {
					if (limit !== undefined && limit <= 0) return;
					let first = true;
					let previous: any;
					let yielded = 0;
					for (const key of getKeys()) {
						const indexedValue = key[0];
						if (!first && compareKeys(previous, indexedValue) === 0) continue;
						first = false;
						previous = indexedValue;
						yield indexedValue;
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

	getValues(indexedValue: any, options: Omit<StoreIteratorOptions, 'start' | 'end'> = {}): Iterable<Id> {
		return super
			.getKeys({ ...options, start: [indexedValue], end: [indexedValue, MAXIMUM_KEY] })
			.map((key) => (key.length > 2 ? key.slice(1) : key[1]));
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
		return this.store.getCount(this._context, { start: indexedValue, end: [indexedValue, MAXIMUM_KEY] });
	}
	throw new Error('getValuesCount is only supported if dupSort=true');
};
