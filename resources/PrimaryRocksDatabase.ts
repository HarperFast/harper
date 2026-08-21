import { RocksDatabase, type RocksDatabaseOptions, constants, type Store, Transaction } from '@harperfast/rocksdb-js';

const FRESH_VERSION_FLAG = constants.FRESH_VERSION_FLAG;
import { WeakLRUCache } from 'weak-lru-cache';
import { when } from '../utility/when.ts';
import { assignStoredFields, entryMap, METADATA, VERSION_REUSED, VERSION_UNVOUCHABLE, type Entry } from './RecordEncoder.ts';

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

	// Match LMDB's remove(key, version) contract without splitting the version check from the delete.
	async removeIfVersion(id: any, version: number): Promise<boolean> {
		let retried = false;
		while (true) {
			let transaction: Transaction | undefined;
			try {
				transaction = new Transaction(this.store);
				const entry = this.#processEntry(super.getSync(id, { transaction }), id);
				if (!entry || entry.version !== version) {
					transaction.abort();
					return false;
				}
				this.#cache?.delete(id);
				super.removeSync(id, { transaction });
				await transaction.commit();
				return true;
			} catch (error: any) {
				try {
					transaction?.abort();
				} catch {}
				// rocksdb-js reports a writer that committed between our read and our commit as ERR_BUSY
				if (retried || error?.code !== 'ERR_BUSY') throw error;
				retried = true;
			}
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
				assignStoredFields(entry.value, originalValue, this.#enc);
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
		// Presence check, not truthiness: a [timestamp][no flags word] record decodes with
		// metadataFlags === 0, and a falsy gate would hand the metadata wrapper itself back as
		// the record value (harper#2012).
		if (raw[METADATA] !== undefined) {
			raw.metadataFlags = raw[METADATA];
			return this.#withEntry(raw, id);
		}
		// Metadata-less values (e.g. records a broken migration stored without the prefix) still
		// get the prototype repair and value→Entry mapping, matching getRange and the LMDB
		// wrapper — only the version is unrecoverable (harper#2012).
		return this.#withEntry({ value: raw } as Entry, id);
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
		// A commit-path base read must reflect the caller's transaction snapshot. The cache-vouch
		// fast path answers a different question — "is this worker's cached value the latest
		// committed?" — and answers even that wrongly for a version a resequenced write reused
		// (one version, two stored values), so a fold on a vouched base can silently drop the
		// concurrent update it folded over. Read the store directly and leave the cache and the
		// VerificationTable untouched (their latest-committed semantics don't fit a snapshot read).
		if (options?.uncachedRead) {
			const raw = options.async ? super.get(id, options) : super.getSync(id, options);
			return when(raw, (result) => this.#processEntry(result, id));
		}
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
		// The parked sentinel is the cross-worker "this key's version must not be vouched for" signal,
		// and it has to be consulted BEFORE the native get on BOTH the cold and the warm path. Cold,
		// because the native get would otherwise seed the slot with the version it reads. Warm, because
		// on a VT miss the native layer re-confirms freshness against the version stored in the record
		// itself ("soft miss") and republishes it — for a record whose stored version was reused, that
		// re-vouches a version two different values share, and overwrites the sentinel, so a worker
		// still holding the pre-merge value would keep being told it is fresh indefinitely.
		const unvouchable = cache !== undefined && this.verifyVersion(id, VERSION_UNVOUCHABLE);

		// Build get options, always merging with caller options to preserve
		// transaction snapshot. Pass expectedVersion when cached:
		//   VT hit  → native returns FRESH_VERSION_FLAG, no DB read
		//   VT miss → native reads DB and auto-populates VT slot
		// For cold reads (no cached version), use populateVersion flag so the
		// native layer seeds the VT slot in the same call.
		// An unvouchable key takes a plain decoding read: no version trust, no VT seeding.
		let getOptions: any;
		if (unvouchable) {
			getOptions = options;
		} else if (expectedVersion != null) {
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
			if (entry.version != null && cache) {
				// Checked before the cacheability gate below: a flagged record with a null or primitive
				// value is just as unvouchable. Normally the slot already holds the sentinel from the
				// write; re-park it for a record flagged before this shipped, or one whose slot a read
				// republished. A store that cannot take it (closing, dropped) must not turn a completed
				// read into a failed one — not caching is the safe outcome either way.
				if (entry.metadataFlags & VERSION_REUSED || entry.version === VERSION_UNVOUCHABLE) {
					if (!unvouchable) {
						try {
							this.populateVersion(id, VERSION_UNVOUCHABLE);
						} catch {
							/* leave the slot alone; this record is not cached regardless */
						}
					}
					if (cachedValue !== undefined) cache.delete(id);
				} else if (unvouchable) {
					// Clean record under a parked sentinel (a post-commit park raced a newer in-order
					// write): stay uncached — restoring the real version from JS would be an unguarded
					// force-set that can overwrite a concurrent write's slot state. The next write to the
					// key clears the sentinel through its own write cycle and vouching resumes.
					if (cachedValue !== undefined) cache.delete(id);
				} else if (entry.value != null && typeof entry.value === 'object') {
					// Only object values can be weakly cached and mapped back to their Entry;
					// primitive/empty values fall through uncached (no fast path, still correct).
					entryMap.set(entry.value, entry);
					cache.setValue(id, entry.value, (entry.size ?? 0) >> 10);
				}
			}
			return entry;
		});
	}

	/**
	 * Park the unvouchable sentinel for a key whose stored version no longer identifies a single
	 * value (see VERSION_REUSED). Called by the transaction's commit success path — the writer is
	 * the only party that knows before any reader decodes the record. A slot that cannot take it
	 * (a newer write's intent holds it) is left alone: that write's cycle supersedes it anyway.
	 */
	parkUnvouchable(id: any): void {
		try {
			this.populateVersion(id, VERSION_UNVOUCHABLE);
		} catch {
			/* a reader that decodes the flagged record re-parks; never fail a completed commit */
		}
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
			if (entry.value?.[METADATA] !== undefined) {
				entry.metadataFlags = entry.value[METADATA];
				Object.assign(entry, entry.value);
			}
			if (entry.value?.constructor === Object && enc.structPrototype) {
				const originalValue = entry.value;
				entry.value = new enc.structPrototype.constructor();
				assignStoredFields(entry.value, originalValue, enc);
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
