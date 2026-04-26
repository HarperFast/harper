import { RocksDatabase, type RocksDatabaseOptions, constants, type Store } from '@harperfast/rocksdb-js';
import { WeakLRUCache } from 'weak-lru-cache';
import { when } from '../utility/when.ts';

const FRESH_VERSION_FLAG = constants.FRESH_VERSION_FLAG;

/**
 * RocksDatabase subclass that layers a per-instance WeakLRUCache on top of the
 * verification table. Cache entries are decoded metadata objects (the shape returned by
 * RecordEncoder.decode for RocksDB records: `{ version, value, [METADATA], ... }`).
 * Freshness is verified with `entry.version` via the process-wide VerificationTable,
 * so reads that hit a fresh VT slot never touch the disk.
 */
export class CachingRocksDatabase extends RocksDatabase {
	#cache = new WeakLRUCache();

	constructor(pathOrStore: string | Store, options?: RocksDatabaseOptions) {
		super(pathOrStore, { ...options, verificationTable: true });
	}

	getSync(id: any, options?: any): any {
		if (options?.transaction) {
			return super.getSync(id, options);
		}
		const cachedValue = this.#cache.getValue(id);
		if (cachedValue !== undefined && cachedValue.version) {
			const result = super.getSync(id, { ...options, expectedVersion: cachedValue.version });
			if (result === FRESH_VERSION_FLAG) return cachedValue;
			if (result === undefined) {
				this.#cache.delete(id);
				return undefined;
			}
			this.#cache.setValue(id, result, result.size >> 10);
			return result;
		}
		const result = super.getSync(id, options);
		if (result !== undefined) {
			this.#cache.setValue(id, result, result.size >> 10);
		}
		return result;
	}

	get(id: any, options?: any): any {
		if (options?.transaction) {
			return super.get(id, options);
		}
		const cachedValue = this.#cache.getValue(id);
		if (cachedValue !== undefined && cachedValue.version) {
			return when(super.get(id, { ...options, expectedVersion: cachedValue.version }), (result) => {
				if (result === FRESH_VERSION_FLAG) return cachedValue;
				if (result === undefined) {
					this.#cache.delete(id);
					return undefined;
				}
				this.#cache.setValue(id, result, result.size >> 10);
				return result;
			});
		}
		return when(super.get(id, options), (result) => {
			if (result !== undefined) {
				this.#cache.setValue(id, result, result.size >> 10);
			}
			return result;
		});
	}

	putSync(id: any, value: any, options?: any): any {
		this.#cache.delete(id);
		return super.putSync(id, value, options);
	}

	removeSync(id: any, options?: any): any {
		this.#cache.delete(id);
		return super.removeSync(id, options);
	}

	open(): CachingRocksDatabase {
		return super.open() as CachingRocksDatabase;
	}

	static open(pathOrStore: string | Store, options?: RocksDatabaseOptions): CachingRocksDatabase {
		return new CachingRocksDatabase(pathOrStore, options).open();
	}
}
