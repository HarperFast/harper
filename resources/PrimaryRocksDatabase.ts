import { RocksDatabase, type RocksDatabaseOptions, type Store } from '@harperfast/rocksdb-js';
import { WeakLRUCache } from 'weak-lru-cache';
import { when } from '../utility/when.ts';
import { entryMap, METADATA, type Entry } from './RecordEncoder.ts';

/**
 * RocksDatabase subclass that owns all primary-store behaviour for Harper tables:
 *   - RecordEncoder metadata extraction (version, metadataFlags, etc.)
 *   - Optional WeakLRUCache keyed on entry version, verified via the process-wide VerificationTable
 *
 * Replaces both the old CachingRocksDatabase and the RocksDB-specific patches applied by
 * handleLocalTimeForGets. Call initStore(rootStore) after open() — or let
 * handleLocalTimeForGets delegate to it automatically via the isPrimaryRocksDatabase marker.
 *
 * Caching is enabled by default; pass { cache: false } to disable (useful for benchmarking
 * or stores where version tracking is not desired).
 *
 * Cache freshness pattern (using the rocksdb-js VT API):
 *   1. verifyVersion(key, cached.version)  → true  → return cached entry (no disk I/O)
 *   2. verifyVersion(key, cached.version)  → false → read from DB, populateVersion, update cache
 */
export class PrimaryRocksDatabase extends RocksDatabase {
	readonly isPrimaryRocksDatabase = true;
	#cache?: WeakLRUCache;
	readCount = 0;
	cachePuts = false;
	declare rootStore: any;
	declare decoder: any;

	get #enc(): any {
		return (this as any).encoder;
	}

	constructor(pathOrStore: string | Store, options?: RocksDatabaseOptions & { cache?: boolean }) {
		const enableCache = (options as any)?.cache !== false;
		super(pathOrStore, enableCache ? { ...options, verificationTable: true } : options);
		if (enableCache) {
			this.#cache = new WeakLRUCache();
		}
	}

	/**
	 * Initialises encoder/decoder state. Must be called once after open() with the root
	 * RocksDatabase. Equivalent to the RocksDB branch of handleLocalTimeForGets, but as
	 * a real method rather than instance-level monkey-patching.
	 */
	initStore(rootStore: RocksDatabase) {
		this.readCount = 0;
		this.cachePuts = false;
		this.rootStore = rootStore;
		this.#enc.rootStore = rootStore;
		this.#enc.isRocksDB = true;
		this.decoder = this.#enc;
	}

	#withEntry(entry: Entry, id: any): Entry {
		if (entry.value) {
			if (entry.value.constructor === Object && this.#enc.structPrototype) {
				const originalValue = entry.value;
				entry.value = new this.#enc.structPrototype.constructor();
				Object.assign(entry.value, originalValue);
			}
			if (typeof entry.value === 'object' && entry.value !== null) {
				entryMap.set(entry.value, entry);
			}
		}
		entry.key = id;
		return entry;
	}

	#processEntry(raw: any, id: any): Entry | undefined {
		if (raw == null) return undefined;
		if (raw[METADATA]) {
			raw.metadataFlags = raw[METADATA];
			return this.#withEntry(raw, id);
		}
		return { value: raw, key: id } as Entry;
	}

	/**
	 * Core read method. Returns a full Entry (with version, metadataFlags, value, …) or
	 * undefined. When caching is enabled and the VerificationTable slot is current,
	 * returns the cached Entry without touching disk.
	 */
	getEntry(id: any, options?: any): any {
		this.readCount++;
		const cache = options?.transaction ? null : this.#cache;

		if (cache) {
			const cached = cache.get(id) as Entry | undefined;
			if (cached !== undefined && cached.version != null && this.verifyVersion(id, cached.version)) {
				return cached;
			}
		}

		const raw = options?.async ? super.get(id, options) : super.getSync(id, options);
		return when(raw, (result) => {
			const entry = this.#processEntry(result, id);
			if (entry?.version != null && cache) {
				this.populateVersion(id, entry.version);
				cache.set(id, entry, (entry.size ?? 0) >> 10);
			}
			return entry;
		});
	}

	getSync(id: any, options?: any): any {
		const entry = this.getEntry(id, options) as Entry;
		const value = entry?.value;
		if (value != null && typeof value === 'object') entryMap.set(value, entry);
		return value;
	}

	get(id: any, options?: any): any {
		return when(this.getEntry(id, { ...options, async: true }), (entry: Entry) => {
			const value = entry?.value;
			if (value != null && typeof value === 'object') entryMap.set(value, entry);
			return value;
		});
	}

	getRange(options?: any): any {
		const iterable = super.getRange(options);
		if (options?.valuesForKey) return iterable.map((v: any) => v?.value);
		if (options?.values === false || options?.onlyCount) return iterable;
		const hasRecordEncoder = !!this.#enc.isRocksDB;
		return iterable.map((entry: any) => {
			if (hasRecordEncoder) {
				if (entry.value?.[METADATA]) {
					entry.metadataFlags = entry.value[METADATA];
					Object.assign(entry, entry.value);
				}
				if (entry.value?.constructor === Object && this.#enc.structPrototype) {
					const originalValue = entry.value;
					entry.value = new this.#enc.structPrototype.constructor();
					for (const key in originalValue) entry.value[key] = originalValue[key];
				}
			}
			return entry;
		});
	}

	putSync(id: any, value: any, options?: any): any {
		this.#cache?.delete(id);
		return super.putSync(id, value, options);
	}

	removeSync(id: any, options?: any): any {
		this.#cache?.delete(id);
		return super.removeSync(id, options);
	}

	open(): PrimaryRocksDatabase {
		return super.open() as PrimaryRocksDatabase;
	}

	static open(pathOrStore: string | Store, options?: RocksDatabaseOptions): PrimaryRocksDatabase {
		return new PrimaryRocksDatabase(pathOrStore, options).open();
	}
}
