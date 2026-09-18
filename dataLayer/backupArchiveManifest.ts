'use strict';

import { packageJson } from '../utility/packageUtils.js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { get as getConfigValue } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

/**
 * The machine-readable identification carried by a `get_backup` archive.
 *
 * The manifest is the first entry in the tar because a `.tar.gz` must be inflated from the start to
 * reach a later entry: a trailing manifest would cost a full pass over a multi-gigabyte archive just
 * to decide whether to reject it.
 *
 * Compatibility is a capability list rather than a version comparison. What makes an archive
 * unreadable is a format the target cannot decode, and the engine-level ones already fail closed on
 * their own (RocksDB refuses a `format_version` it does not understand). The ones that do not are
 * record struct mode (DESIGN.md "Struct mode is gated to primary DBIs"), transaction-log framing,
 * and deflate-compressed blob bodies (harper#2443). So the producer declares what a reader needs and
 * the reader refuses any token it does not have; new tokens are additive, and an older reader
 * refusing an unknown one is the intended answer.
 */

/** Tar entry name of the manifest. First entry in the archive. */
export const ARCHIVE_MANIFEST_ENTRY = 'harper-backup.json';

/** Bumped only when the document shape changes incompatibly; a reader refuses a version above its own. */
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
	/**
	 * Provenance, never gated on — `requires` is the gate. This is what a support engineer needs
	 * when an archive shows up months later and will not restore, and it is deliberately separate
	 * so nobody is tempted to turn a description into a compatibility check.
	 */
	source: BackupArchiveSource;
}

export interface BackupArchiveSource {
	/**
	 * Names of the built-in components the producing distribution registered — `replication`,
	 * `secretCustody`, `waf` on Harper Pro, empty on OSS core. This is the only honest
	 * pro-vs-OSS signal that exists: core has no edition flag, and its `package.json` is core's own
	 * even when Pro bundles it, so `harper_version` cannot distinguish them.
	 */
	built_in_components: string[];
	node_version: string;
	platform: string;
	arch: string;
	/** Allowlisted storage settings only — see {@link PROVENANCE_SETTINGS}. */
	settings: Record<string, unknown>;
}

/**
 * The settings recorded in `source.settings`, as an explicit allowlist rather than a config dump.
 * An archive leaves the host, so the rule is: describe how the data was written, and never carry a
 * path, a hostname, a credential, or anything under auth/network/TLS — `storage.path` and
 * `storage.blobPaths` are excluded for exactly that reason, and `blob_root_count` already records
 * the only part of the blob layout a reader can act on.
 */
const PROVENANCE_SETTINGS: readonly string[] = [
	CONFIG_PARAMS.STORAGE_COMPRESSION,
	CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD,
	CONFIG_PARAMS.STORAGE_BLOBS_COMPRESSION,
	CONFIG_PARAMS.STORAGE_CACHING,
	CONFIG_PARAMS.STORAGE_WRITEASYNC,
	CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC,
	CONFIG_PARAMS.STORAGE_PAGESIZE,
];

/**
 * Best-effort: a manifest is worth writing without provenance, and the offline CLI may hold no
 * config at all. Never let describing the source fail the backup that produced it.
 */
function collectSource(): BackupArchiveSource {
	// Read directly rather than importing Application.ts's getEnvBuiltInComponents(): that module is
	// ~5k lines and nothing in dataLayer depends on it, and this is a cold path. configUtils.ts:549
	// reads the same variable the same way. Format is `name=packageIdentifier`, comma-separated.
	const builtInComponents = (process.env.HARPER_BUILTIN_COMPONENTS ?? '')
		.split(',')
		.map((definition) => definition.trim().split('=')[0])
		.filter(Boolean);
	const settings: Record<string, unknown> = {};
	for (const param of PROVENANCE_SETTINGS) {
		try {
			const value = getConfigValue(param);
			if (value !== undefined) settings[param] = value;
		} catch {
			/* config not loaded */
		}
	}
	// A dictionary is an external file the data depends on, so record THAT one was configured
	// without recording where it lives.
	try {
		if (getConfigValue(CONFIG_PARAMS.STORAGE_COMPRESSION_DICTIONARY)) settings.storage_compression_dictionary = true;
	} catch {
		/* config not loaded */
	}
	return {
		built_in_components: builtInComponents,
		node_version: process.version,
		platform: process.platform,
		arch: process.arch,
		settings,
	};
}

/**
 * Read from Harper's own dependency pin rather than resolving the installed package: the binding
 * exports no version, and a `require` here is a ReferenceError under ESM while working under the
 * CommonJS build — so the value would silently differ by runtime. The pin is exact, so this is the
 * version that shipped.
 */
function rocksdbJsVersion(): string {
	return packageJson.dependencies?.['@harperfast/rocksdb-js'] ?? '';
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
		source: collectSource(),
	};
}

export function serializeArchiveManifest(manifest: BackupArchiveManifest): string {
	return JSON.stringify(manifest, null, '\t') + '\n';
}

/**
 * A malformed manifest is an error, not a silent "unidentified": an archive carrying an unreadable
 * manifest is a different situation from one that predates manifests, and only the second is
 * eligible for the operator's provenance override.
 */
export function parseArchiveManifest(contents: string): BackupArchiveManifest {
	let parsed: any;
	try {
		parsed = JSON.parse(contents);
	} catch {
		// deliberately not quoting the parse error: reading a property off an arbitrary thrown value is
		// its own failure mode, and the entry name is what identifies the problem
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is not valid JSON`);
	}
	if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.archive_schema_version)) {
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is missing 'archive_schema_version'`);
	}
	if (!Array.isArray(parsed.requires) || parsed.requires.some((entry: any) => typeof entry !== 'string')) {
		throw new ClientError(`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} is missing a valid 'requires' list`);
	}
	return parsed as BackupArchiveManifest;
}

/** Refuse an archive this build cannot read. Both checks fail closed on the unknown. */
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
