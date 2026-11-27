import { supportedCompression } from '@harperfast/rocksdb-js';

export { supportedCompression };

/**
 * The codec `storage.rocks.compression` names, read the way the database open reads it: unset or
 * blank is `undefined` (storage.compression decides), anything else is trimmed and lowercased and must
 * be a codec this build of rocksdb-js provides. Config validation calls this too, so a value
 * `set_configuration` accepts is one the next start opens.
 */
export function parseRocksCompression(configured: unknown): string | undefined {
	if (configured === undefined || configured === null) return undefined;
	const requested = String(configured).trim().toLowerCase();
	if (!requested) return undefined;
	if (!supportedCompression.includes(requested)) {
		throw new Error(
			`storage.rocks.compression="${requested}" is not available in this build of @harperfast/rocksdb-js. Supported: ${supportedCompression.join(', ')}`
		);
	}
	return requested;
}
