import { RocksDatabase, type RocksDatabaseOptions, constants, type Store } from '@harperfast/rocksdb-js';

const FRESH_VERSION_FLAG = constants.FRESH_VERSION_FLAG;
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
		const enableCache = (options as any)?.cache === true;
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
		const entry = { value: raw, key: id } as Entry;
		// map metadata-less values too, so getEntry guarantees the value→Entry
		// mapping for every object value it returns (getSync/get rely on this)
		if (typeof raw === 'object') entryMap.set(raw, entry);
		return entry;
	}

	/**
	 * Core read method. Returns a full Entry (with version, metadataFlags, value, …) or
	 * undefined. When caching is enabled, passes `expectedVersion` to the native layer so
	 * a single call handles both verification (returns FRESH_VERSION_FLAG on hit) and VT
	 * population (auto-seeded on DB read). Only cold reads (no cached version) need a
	 * separate populateVersion call.
	 */
	getEntry(id: any, options?: any): any {
		this.readCount++;
		const cache = this.#cache;
		// The cache stores the record *value* (weakly, via setValue) rather than
		// the Entry: a WeakRef-wrapped value lets the LRFU expirer release it once
		// it cycles out of the LRU stages (a raw Entry stored via set() has neither
		// a .deref nor a .cache hook, so it would never be reclaimed — an unbounded
		// leak). The value→Entry WeakMap (entryMap) recovers the Entry metadata
		// (version, flags) needed for the fast path while the value is live.
		const cachedValue = cache?.getValue(id);
		const cached =
			cachedValue != null && typeof cachedValue === 'object'
				? (entryMap.get(cachedValue) as Entry | undefined)
				: undefined;
		const expectedVersion = cached?.version;

		// Build get options, always merging with caller options to preserve
		// transaction snapshot. Pass expectedVersion when cached:
		//   VT hit  → native returns FRESH_VERSION_FLAG, no DB read
		//   VT miss → native reads DB and auto-populates VT slot
		// For cold reads (no cached version), use populateVersion flag so the
		// native layer seeds the VT slot in the same call.
		let getOptions: any;
		if (expectedVersion != null) {
			getOptions = options ? { ...options, expectedVersion } : { expectedVersion };
		} else if (cache) {
			getOptions = options ? { ...options, populateVersion: true } : { populateVersion: true };
		} else {
			getOptions = options;
		}
		const raw = options?.async ? super.get(id, getOptions) : super.getSync(id, getOptions);

		return when(raw, (result) => {
			if (result === FRESH_VERSION_FLAG) return cached;
			const entry = this.#processEntry(result, id);
			if (entry == null) {
				if (cache && cachedValue !== undefined) cache.delete(id);
				return undefined;
			}
			// Only object values can be weakly cached and mapped back to their Entry;
			// primitive/empty values fall through uncached (no fast path, still correct).
			if (entry.version != null && cache && entry.value != null && typeof entry.value === 'object') {
				entryMap.set(entry.value, entry);
				cache.setValue(id, entry.value, (entry.size ?? 0) >> 10);
			}
			return entry;
		});
	}

	getSync(id: any, options?: any): any {
		const entry = this.getEntry(id, options) as Entry;
		return entry?.value;
	}

	get(id: any, options?: any): any {
		return when(this.getEntry(id, { ...options, async: true }), (entry: Entry) => entry?.value);
	}

	getRange(options?: any): any {
		const iterable = super.getRange(options);
		if (options?.valuesForKey) return iterable.map((v: any) => v?.value);
		if (options?.values === false || options?.onlyCount) return iterable;
		if (!this.#enc.isRocksDB) return iterable;
		const enc = this.#enc;
		return iterable.map((entry: any) => {
			if (entry.value?.[METADATA]) {
				entry.metadataFlags = entry.value[METADATA];
				Object.assign(entry, entry.value);
			}
			if (entry.value?.constructor === Object && enc.structPrototype) {
				const originalValue = entry.value;
				entry.value = new enc.structPrototype.constructor();
				for (const key in originalValue) entry.value[key] = originalValue[key];
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

	clearSync(): void {
		// clearSync wipes every record; the per-instance cache must be dropped
		// too, otherwise a cached entry would survive the clear and be served as
		// a stale "still exists" hit on the next read.
		this.#cache?.clear();
		return super.clearSync();
	}

	clear(): Promise<void> {
		this.#cache?.clear();
		return super.clear();
	}

	open(): PrimaryRocksDatabase {
		return super.open() as PrimaryRocksDatabase;
	}

	static open(pathOrStore: string | Store, options?: RocksDatabaseOptions): PrimaryRocksDatabase {
		return new PrimaryRocksDatabase(pathOrStore, options).open();
	}
}
