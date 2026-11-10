// Resolves the RocksDB memory configuration (block cache + WriteBufferManager) from raw
// config values. Kept as a pure function so the defaulting logic can be unit tested without
// opening a database or touching the process-global RocksDatabase.config side effect.
//
// Values flow in from configUtils.castConfigValue (via envGet), which produces proper
// numbers/booleans/null — so we enforce types rather than coerce, and anything that isn't the
// expected type falls through to the default.

export interface RocksMemoryConfigInput {
	configuredBlockCacheSize: unknown;
	configuredWriteBufferManagerSize: unknown;
	configuredCostToCache: unknown;
	configuredAllowStall: unknown;
	configuredFlushPolicy: unknown;
	// min(process.constrainedMemory() ?? Infinity, totalmem()) — the cgroup-aware memory base.
	availableMemory: number;
}

const FLUSH_POLICIES = ['oldest', 'largest', 'largestAcrossDBs'] as const;
type WriteBufferManagerFlushPolicy = (typeof FLUSH_POLICIES)[number];

export interface RocksMemoryConfig {
	blockCacheSize: number;
	writeBufferManagerSize?: number;
	writeBufferManagerCostToCache?: boolean;
	writeBufferManagerAllowStall?: boolean;
	writeBufferManagerFlushPolicy?: WriteBufferManagerFlushPolicy;
}

export function resolveRocksMemoryConfig(input: RocksMemoryConfigInput): RocksMemoryConfig {
	const {
		configuredBlockCacheSize,
		configuredWriteBufferManagerSize,
		configuredCostToCache,
		configuredAllowStall,
		configuredFlushPolicy,
		availableMemory,
	} = input;
	// Block cache: an explicit positive number wins, otherwise 25% of available memory. Floored
	// because RocksDB expects integer byte counts and the percentage math produces fractions.
	const blockCacheSize = Math.floor(
		typeof configuredBlockCacheSize === 'number' && configuredBlockCacheSize > 0
			? configuredBlockCacheSize
			: availableMemory * 0.25
	);
	// WriteBufferManager size: an explicit number is honored (0 disables); any other value
	// (unset/misconfigured) defaults to 1/3 of the block cache. Floored for the same reason.
	const writeBufferManagerSize = Math.floor(
		typeof configuredWriteBufferManagerSize === 'number' ? configuredWriteBufferManagerSize : blockCacheSize / 3
	);
	const config: RocksMemoryConfig = { blockCacheSize };
	// costToCache and allowStall only matter when the WBM is enabled. allowStall defaults to false
	// so the budget is a soft cap: a stalling manager parks every writer in the process inside
	// DBImpl::WriteBufferManagerStallWrites(), and once the budget is held across enough column
	// families nothing triggers the flush that would release them, so the only exit is a restart
	// (#2490). The cost is memory — a non-stalling manager keeps each family's derived
	// conflict-check history as a floor RocksDB never trims below, until HarperFast/rocksdb-js#821.
	if (writeBufferManagerSize > 0) {
		config.writeBufferManagerSize = writeBufferManagerSize;
		config.writeBufferManagerCostToCache = typeof configuredCostToCache === 'boolean' ? configuredCostToCache : true;
		config.writeBufferManagerAllowStall = typeof configuredAllowStall === 'boolean' ? configuredAllowStall : false;
		if ((FLUSH_POLICIES as readonly unknown[]).includes(configuredFlushPolicy)) {
			config.writeBufferManagerFlushPolicy = configuredFlushPolicy as WriteBufferManagerFlushPolicy;
		}
	}
	return config;
}

// The native layer throws on anything but a non-negative safe integer, and 0 means automatic.
export function resolveRocksArenaBlockSize(configuredArenaBlockSize: unknown): number | undefined {
	return Number.isSafeInteger(configuredArenaBlockSize) && (configuredArenaBlockSize as number) > 0
		? (configuredArenaBlockSize as number)
		: undefined;
}

// weak-lru-cache splits a cache into 4 rings of `cacheSize >> 2` positions: under 4 there are none,
// which it silently replaces with its own default, and a ring of 0x400000 positions never wraps.
export const MIN_RECORD_CACHE_SIZE = 4;
export const MAX_RECORD_CACHE_SIZE = 0x3fffff * 4 + 3;
export const DEFAULT_RECORD_CACHE_SIZE = 32_768;

export function resolveRecordCacheSize(configuredRecordCacheSize: unknown): number {
	return Number.isSafeInteger(configuredRecordCacheSize) &&
		(configuredRecordCacheSize as number) >= MIN_RECORD_CACHE_SIZE &&
		(configuredRecordCacheSize as number) <= MAX_RECORD_CACHE_SIZE
		? (configuredRecordCacheSize as number)
		: DEFAULT_RECORD_CACHE_SIZE;
}

/** rocksdb-js's default, and the floor: Harper only ever enlarges the table. */
export const DEFAULT_VERIFICATION_TABLE_ENTRIES = 131_072;
const VERIFICATION_TABLE_SLOT_BYTES = 8;

export interface VerificationTableInput {
	recordCacheSize: number;
	/** The threads that open tables, each holding up to `recordCacheSize` records. */
	threadCount: number;
	availableMemory: number;
}

/**
 * Two slots per record the threads' caches can hold, in a power of two. rocksdb-js allocates and zeroes
 * the whole table when it is first used, whether or not the caches ever fill, so the table is also held
 * to 1/64 of memory.
 */
export function resolveVerificationTableEntries({
	recordCacheSize,
	threadCount,
	availableMemory,
}: VerificationTableInput): number {
	const wanted = 2 * recordCacheSize * threadCount;
	let entries = DEFAULT_VERIFICATION_TABLE_ENTRIES;
	while (entries < wanted && entries * 2 * VERIFICATION_TABLE_SLOT_BYTES <= availableMemory / 64) entries *= 2;
	return entries;
}
