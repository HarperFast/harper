import {
	type CountEstimate,
	type CountEstimateOptions,
	DBI,
	type StoreIteratorOptions,
	type StorePutOptions,
	type StoreRemoveOptions,
	RocksDatabase,
} from '@harperfast/rocksdb-js';
import { Id } from './ResourceInterface.ts';
import { MAXIMUM_KEY } from 'ordered-binary';

declare module '@harperfast/rocksdb-js' {
	interface DBI<T> {
		getValuesCount(indexedValue: any): number;
	}
}

/**
 * Widen value-space bounds to `[value, MAXIMUM_KEY]` composite bounds. The base implementation's
 * encoded-byte successor of the bare indexed value would exclude the wrong entries on composite
 * `[indexedValue, primaryKey]` keys.
 */
function translateIndexBounds<
	T extends { start?: any; end?: any; exclusiveStart?: boolean; inclusiveEnd?: boolean; reverse?: boolean },
>(options: T): T {
	let { start, end } = options;
	const { exclusiveStart, inclusiveEnd, reverse } = options;
	if ((reverse ? !exclusiveStart : exclusiveStart) && start !== undefined) {
		start = [start, MAXIMUM_KEY];
	}
	if ((reverse ? !inclusiveEnd : inclusiveEnd) && end !== undefined) {
		end = [end, MAXIMUM_KEY];
	}
	return { ...options, start, end };
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
		return super.getRange(translateIndexBounds(options)).map(({ key }) => {
			return { key: key[0], value: key.length > 2 ? key.slice(1) : key[1] };
		});
	}

	/**
	 * Estimate the entry count of a range of indexed values. Shares `getRange`'s bound translation
	 * so a planner estimate always covers exactly the range execution would iterate.
	 */
	estimateCount(options?: CountEstimateOptions): CountEstimate {
		return super.estimateCount(translateIndexBounds(options ?? {}));
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
