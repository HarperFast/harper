/** The codec names rocksdb-js defines; which of them a build provides is known only once rocksdb-js loads. */
export const ROCKS_COMPRESSION_ALGORITHMS: readonly string[] = [
	'none',
	'snappy',
	'zlib',
	'bzip2',
	'lz4',
	'lz4hc',
	'xpress',
	'zstd',
];

let buildCodecs: readonly string[] | undefined;

/**
 * Records the codecs this build of rocksdb-js provides; `rocksCompressionSupport.ts` calls it where
 * rocksdb-js is loaded. Config validation does not load the native addon itself: modules that validate
 * config must still load where native addons cannot.
 */
export function setSupportedRocksCompression(codecs: readonly string[]): void {
	buildCodecs = codecs;
}

export function supportedRocksCompression(): readonly string[] {
	return buildCodecs ?? ROCKS_COMPRESSION_ALGORITHMS;
}

/**
 * The codec `storage.rocks.compression` names, read the way the database open reads it: unset or
 * blank is `undefined` (storage.compression decides), anything else is trimmed and lowercased and must
 * be a codec this build provides. Config validation calls this too, so a value `set_configuration`
 * accepts is one the next start opens.
 */
export function parseRocksCompression(configured: unknown): string | undefined {
	if (configured === undefined || configured === null) return undefined;
	const requested = String(configured).trim().toLowerCase();
	if (!requested) return undefined;
	const supported = supportedRocksCompression();
	if (!supported.includes(requested)) {
		throw new Error(
			`storage.rocks.compression="${requested}" is not available in this build of @harperfast/rocksdb-js. Supported: ${supported.join(', ')}`
		);
	}
	return requested;
}
