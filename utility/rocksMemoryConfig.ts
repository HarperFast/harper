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
	// min(process.constrainedMemory() ?? Infinity, totalmem()) — the cgroup-aware memory base.
	availableMemory: number;
}

export interface RocksMemoryConfig {
	blockCacheSize: number;
	writeBufferManagerSize?: number;
	writeBufferManagerCostToCache?: boolean;
	writeBufferManagerAllowStall?: boolean;
}

export function resolveRocksMemoryConfig(input: RocksMemoryConfigInput): RocksMemoryConfig {
	const {
		configuredBlockCacheSize,
		configuredWriteBufferManagerSize,
		configuredCostToCache,
		configuredAllowStall,
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
	// costToCache and allowStall only matter when the WBM is enabled. allowStall defaults to true
	// so the buffer applies write backpressure rather than letting memtables grow unbounded, which
	// also keeps bulk ingest from outrunning the memtable flush/conflict-check window.
	if (writeBufferManagerSize > 0) {
		config.writeBufferManagerSize = writeBufferManagerSize;
		config.writeBufferManagerCostToCache = typeof configuredCostToCache === 'boolean' ? configuredCostToCache : true;
		config.writeBufferManagerAllowStall = typeof configuredAllowStall === 'boolean' ? configuredAllowStall : true;
	}
	return config;
}
