/**
 * Wraps bytes so the store writes them verbatim instead of encoding them. lmdb-js and rocksdb-js
 * both recognize this sentinel key.
 */
export function asBinary(buffer: Uint8Array): { '\x10binary-data\x02': Uint8Array } {
	return { '\x10binary-data\x02': buffer };
}
