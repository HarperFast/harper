/**
 * The tables certificate verification caches into. Every node declares them in this shape at every writable
 * start, whether or not it ever verifies a certificate: they replicate, and only an `expiration` stored in the
 * node's own catalog arms the cleanup scan that removes the rows replicated to it. See dataLayer/DESIGN.md,
 * "System table bootstrap".
 */

import { databases, table, type Table } from '../../resources/databases.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import { SYSTEM_SCHEMA_NAME } from '../../utility/hdbTerms.ts';
import { CRL_DEFAULTS, OCSP_DEFAULTS } from './configValidation.ts';
import { CRL_DEFAULT_VALIDITY_PERIOD } from './verificationConfig.ts';

export const CERTIFICATE_CACHE_TABLE = 'hdb_certificate_cache';
export const CRL_CACHE_TABLE = 'hdb_crl_cache';
export const REVOKED_CERTIFICATES_TABLE = 'hdb_revoked_certificates';

// A table's expiration bounds only a row written without an expiry of its own; every writer here sets one.
// For a verdict, the shorter of the two methods' default lifetimes.
const CERTIFICATE_CACHE_EXPIRATION_SECONDS = Math.min(OCSP_DEFAULTS.cacheTtl, CRL_DEFAULTS.cacheTtl) / 1000;
const CRL_CACHE_EXPIRATION_SECONDS = CRL_DEFAULTS.cacheTtl / 1000;
// Never shorter than a revocation's own window, which would admit a revoked certificate early.
const REVOKED_CERTIFICATES_EXPIRATION_SECONDS = (CRL_DEFAULT_VALIDITY_PERIOD + CRL_DEFAULTS.gracePeriod) / 1000;

const MAX_OUTSTANDING_EVICTIONS = 100;

export function declareCertificateCacheTable(): Table {
	return table<Table>({
		table: CERTIFICATE_CACHE_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		schemaDefined: true,
		expiration: CERTIFICATE_CACHE_EXPIRATION_SECONDS,
		attributes: [
			{ name: 'certificate_id', isPrimaryKey: true },
			{ name: 'status' },
			{ name: 'reason' },
			{ name: 'checked_at' },
			{ name: 'method' },
		],
	});
}

export function declareCRLCacheTable(): Table {
	return table<Table>({
		table: CRL_CACHE_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		schemaDefined: true,
		expiration: CRL_CACHE_EXPIRATION_SECONDS,
		attributes: [
			{ name: 'distribution_point', isPrimaryKey: true },
			{ name: 'issuer_dn' },
			{ name: 'crl_blob' },
			{ name: 'this_update' },
			{ name: 'next_update' },
			{ name: 'signature_valid' },
		],
	});
}

export function declareRevokedCertificatesTable(): Table {
	return table<Table>({
		table: REVOKED_CERTIFICATES_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		schemaDefined: true,
		expiration: REVOKED_CERTIFICATES_EXPIRATION_SECONDS,
		attributes: [
			{ name: 'composite_id', isPrimaryKey: true },
			{ name: 'serial_number', indexed: true },
			{ name: 'issuer_key_id', indexed: true },
			{ name: 'revocation_date' },
			{ name: 'revocation_reason' },
			{ name: 'crl_source', indexed: true },
			{ name: 'crl_next_update' },
		],
	});
}

/**
 * Declares the three tables and waits for any index backfill that starts, reading its outcome back from the
 * catalog because a failed backfill still settles. After the first declaration on a node, it reclaims the
 * verdicts cached before a verdict carried its own expiry.
 */
export async function ensureCertificateVerificationTables(): Promise<void> {
	const reclaimLegacyVerdicts = databases.system?.[CERTIFICATE_CACHE_TABLE]?.expirationMS === undefined;
	const declared = [declareCertificateCacheTable(), declareCRLCacheTable(), declareRevokedCertificatesTable()];
	if (reclaimLegacyVerdicts) await evictVerdictsWithoutExpiry(declared[0]);
	const incomplete: string[] = [];
	for (const Table of declared) {
		await Table.indexingOperation;
		for (const { name, indexed } of Table.attributes) {
			if (!indexed) continue;
			const descriptor = Table.dbisDB.getSync(`${Table.tableName}/${name}`);
			if (descriptor?.indexingFailed || descriptor?.indexingPID) incomplete.push(`${Table.tableName}.${name}`);
		}
	}
	if (incomplete.length > 0) {
		throw new ServerError(
			`The index backfill of system.${incomplete.join(', system.')} did not complete; the next start retries it`
		);
	}
}

/**
 * Those verdicts were stored with no expiry, so they would never be removed. Their keys are never read again
 * (createCacheKey hashes a key version), so this only reclaims their space, with local evictions.
 */
async function evictVerdictsWithoutExpiry(CertificateCache: any): Promise<void> {
	const outstanding: unknown[] = new Array(MAX_OUTSTANDING_EVICTIONS);
	let evictions = 0;
	for (const { key, value, version, expiresAt } of CertificateCache.primaryStore.getRange({
		start: false,
		versions: true,
		snapshot: false,
		lazy: true,
	})) {
		if (value == null || expiresAt >= 0) continue;
		const slot = evictions++ % MAX_OUTSTANDING_EVICTIONS;
		await outstanding[slot];
		outstanding[slot] = CertificateCache.evict(key, value, version);
		// yields between evictions, as the table's own cleanup scan does, so LMDB can renew its read transaction
		await new Promise(setImmediate);
	}
	await Promise.all(outstanding);
}
