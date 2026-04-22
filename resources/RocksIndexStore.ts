import {
	DBI,
	Store,
	type StoreContext,
	type StoreIteratorOptions,
	type StorePutOptions,
	type StoreRemoveOptions,
} from '@harperfast/rocksdb-js';
import { Id } from './ResourceInterface.ts';
import { MAXIMUM_KEY } from 'ordered-binary';

declare module '@harperfast/rocksdb-js' {
	interface DBI<T> {
		getValuesCount(indexedValue: any): number;
	}
}

export class RocksIndexStore extends Store {
	/**
	 * Get all entries matching the range
	 * @param options
	 */
	getRange(context: StoreContext, options: StoreIteratorOptions): Iterable<any> {
		let { start, end, exclusiveStart, inclusiveEnd, reverse } = options;
		if ((reverse ? !exclusiveStart : exclusiveStart) && start !== undefined) {
			start = [start, MAXIMUM_KEY];
		}
		if ((reverse ? !inclusiveEnd : inclusiveEnd) && end !== undefined) {
			end = [end, MAXIMUM_KEY];
		}
		const translatedOptions = { ...options, start, end };
		return super.getRange(context, translatedOptions).map(({ key }) => {
			return { key: key[0], value: key.length > 2 ? key.slice(1) : key[1] };
		});
	}

	/**
	 * Translate a put with indexed value and primary key to an underlying put
	 * @param indexedValue - ignored, only used by LMDB
	 * @param primaryKey
	 * @param txnId
	 */
	put(context: StoreContext, indexedValue: any, primaryKey: Id, options: StorePutOptions) {
		return super.putSync(context, [indexedValue, primaryKey], null, options);
	}

	putSync(context: StoreContext, indexedValue: any, primaryKey: Id, options: StorePutOptions) {
		return super.putSync(context, [indexedValue, primaryKey], null, options);
	}

	remove(context: StoreContext, indexedValue: any, primaryKey: Id, options?: StoreRemoveOptions) {
		return super.removeSync(context, [indexedValue, primaryKey], options);
	}

	removeSync(context: StoreContext, indexedValue: any, options?: StoreRemoveOptions) {
		// the removeSync operation only takes 2 arguments, and we are stuck inside the store interface, so we need to pass
		// the removed primary key in the options
		let primaryKey = options.primaryKey;
		super.removeSync(context, [indexedValue, primaryKey], options);
	}
}

/**
 * Add `getValuesCount` to the DBI prototype which is used by the `RocksDatabase` and `Transaction`
 * classes.
 */
DBI.prototype.getValuesCount = function getValuesCount(indexedValue: any) {
	if (this.store instanceof RocksIndexStore) {
		return this.store.getCount(this._context, { start: indexedValue, end: [indexedValue, MAXIMUM_KEY] });
	}
	throw new Error('getValuesCount is only supported if dupSort=true');
};
