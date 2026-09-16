'use strict';

import { packageJson } from '../utility/packageUtils.js';
import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * The machine-readable identification carried by a `get_backup` archive.
 *
 * Archives produced before this existed carry only human-readable READMEs, so a reader cannot tell
 * what produced them and cannot refuse one it is unable to open. That is the whole reason this
 * ships ahead of any consumer: every archive taken before it exists is unidentifiable, and that set
 * only grows.
 *
 * The manifest is the **first** entry in the tar. A `.tar.gz` has to be inflated from the start to
 * reach a later entry, so a trailing manifest would cost a full pass over a multi-gigabyte archive
 * just to decide whether to reject it; the first entry is readable after a few kilobytes.
 *
 * ## Compatibility is expressed as capabilities, not as a version comparison
 *
 * "Refuse an archive from a newer Harper" is the wrong rule in both directions: most Harper
 * releases change nothing about the on-disk formats an archive carries, and the changes that *do*
 * matter are not all tied to the Harper version. What actually makes an archive unreadable is a
 * format the target cannot decode — a newer RocksDB `format_version`, records written in a struct
 * mode the reader lacks (DESIGN.md "Struct mode is gated to primary DBIs"), a transaction-log
 * framing change, or deflate-compressed blob bodies (harper#2443) on a build with no deflate
 * support. Engine-level formats fail closed on their own: RocksDB refuses to open a directory whose
 * `format_version` it does not understand. The rest do not, which is what `requires` is for.
 *
 * So the producer declares the capabilities a reader needs, and the reader refuses any it does not
 * have. New capability tokens are additive: an older reader refuses an archive naming a token it has
 * never heard of, which is the correct answer, and no version table has to be maintained.
 */

/** Tar entry name of the manifest. First entry in the archive. */
export const ARCHIVE_MANIFEST_ENTRY = 'harper-backup.json';

/**
 * Structure of the manifest document itself. Bumped only when the shape changes incompatibly — a
 * reader refuses a schema version it does not understand, because it cannot trust `requires` from a
 * document it cannot parse correctly.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;

/** Capability tokens this build can satisfy when reading an archive. */
export const SUPPORTED_ARCHIVE_CAPABILITIES: readonly string[] = [
	// The database directory layout a rocksdb-js stream backup produces: engine files at the archive
	// root plus `transaction_logs/<store>/`.
	'rocksdb-stream-backup',
	// `blobs/<rootIndex>/…` trees addressed by the root index a record persists.
	'blob-root-index',
	// Blob bodies that may be deflate-compressed (harper#2443).
	'blob-deflate',
];

export interface BackupArchiveManifest {
	archive_schema_version: number;
	/** Harper release that produced the archive. Recorded for operators and logs, never gated on. */
	harper_version: string;
	/** Binding version, which is what actually fixes the engine and transaction-log formats. */
	rocksdb_js_version: string;
	database: string;
	blobs: boolean;
	blob_root_count: number;
	/** Capability tokens a reader must support; see the module note. */
	requires: string[];
	/**
	 * Names of the roles that granted access to this database, or null when the producer could not
	 * enumerate them (the offline CLI has no loaded `system` database). The archive carries no role
	 * definitions — a restore reports which of these names are absent locally, and never creates one.
	 */
	roles: string[] | null;
	created_at: number;
}

function rocksdbJsVersion(): string {
	const declared = packageJson.dependencies?.['@harperfast/rocksdb-js'] ?? '';
	try {
		return require('@harperfast/rocksdb-js/package.json').version ?? declared;
	} catch {
		return declared;
	}
}

export function buildArchiveManifest({
	databaseName,
	blobs,
	blobRootCount,
	roles,
}: {
	databaseName: string;
	blobs: boolean;
	blobRootCount: number;
	roles: string[] | null;
}): BackupArchiveManifest {
	const requires = ['rocksdb-stream-backup'];
	if (blobs) requires.push('blob-root-index', 'blob-deflate');
	return {
		archive_schema_version: ARCHIVE_SCHEMA_VERSION,
		harper_version: packageJson.version,
		rocksdb_js_version: rocksdbJsVersion(),
		database: databaseName,
		blobs,
		blob_root_count: blobRootCount,
		requires,
		roles,
		created_at: Date.now(),
	};
}

export function serializeArchiveManifest(manifest: BackupArchiveManifest): string {
	return JSON.stringify(manifest, null, '\t') + '\n';
}

/**
 * Parse a manifest read out of an archive. Anything that is not a well-formed manifest is an error
 * rather than a silent "unidentified": an archive that carries a manifest entry Harper cannot read
 * is a different situation from one that predates manifests, and only the second is eligible for the
 * operator's provenance override.
 */
export function parseArchiveManifest(contents: string): BackupArchiveManifest {
	let parsed: any;
	try {
		parsed = JSON.parse(contents);
	} catch (error: any) {
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is not valid JSON: ${error.message}`);
	}
	if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.archive_schema_version)) {
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is missing 'archive_schema_version'`);
	}
	if (!Array.isArray(parsed.requires) || parsed.requires.some((entry: any) => typeof entry !== 'string')) {
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is missing a valid 'requires' list`);
	}
	return parsed as BackupArchiveManifest;
}

/**
 * Refuse an archive this build cannot read. Both checks answer the same question — is there
 * something in here we do not understand — and both fail closed on the unknown.
 */
export function assertArchiveRestorable(manifest: BackupArchiveManifest): void {
	if (manifest.archive_schema_version > ARCHIVE_SCHEMA_VERSION) {
		throw new ClientError(
			`This archive uses manifest schema version ${manifest.archive_schema_version}, but this Harper understands up to ${ARCHIVE_SCHEMA_VERSION}. ` +
				`It was produced by Harper ${manifest.harper_version ?? 'unknown'}; restore it with that version or newer.`
		);
	}
	const unsupported = manifest.requires.filter((capability) => !SUPPORTED_ARCHIVE_CAPABILITIES.includes(capability));
	if (unsupported.length > 0) {
		throw new ClientError(
			`This archive requires archive capabilities this Harper does not have: ${unsupported.join(', ')}. ` +
				`It was produced by Harper ${manifest.harper_version ?? 'unknown'} with rocksdb-js ${manifest.rocksdb_js_version ?? 'unknown'}.`
		);
	}
}

/** How an archive's provenance should be reported back to the operator. */
export function describeArchiveProvenance(manifest: BackupArchiveManifest | null): Record<string, unknown> {
	if (!manifest) return { identified: false };
	return {
		identified: true,
		harper_version: manifest.harper_version,
		rocksdb_js_version: manifest.rocksdb_js_version,
		source_database: manifest.database,
		blobs: manifest.blobs,
		blob_root_count: manifest.blob_root_count,
		...(manifest.roles ? { roles: manifest.roles } : {}),
	};
}
