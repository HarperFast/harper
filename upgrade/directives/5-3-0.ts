'use strict';

// 5.3.0 — introduces system.hdb_oidc_trust and system.hdb_oidc_token_use for OIDC trusted
// publishing (#2171).
//
// Fresh installs get the table from json/systemSchema.json; this covers existing installs. The
// version must match the release that ships the dependent operations — see 5-1-0.ts for what
// happens when it does not, and DESIGN.md "System table bootstrap" for the three touchpoints.

import { databases } from '../../resources/databases.ts';
import systemSchema from '../../json/systemSchema.json';
import * as terms from '../../utility/hdbTerms.ts';
import * as initPaths from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import bridge from '../../dataLayer/harperBridge/harperBridge.ts';
import hdbLogger from '../../utility/logging/harper_logger.ts';

const OIDC_TRUST_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME;
const OIDC_TOKEN_USE_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TOKEN_USE_TABLE_NAME;

/**
 * The replay table gets the same bootstrap as the trust table, for a reason specific to it: replay
 * records must replicate, and a node that has never completed an exchange would otherwise not have
 * the table at all when a peer's record arrives. Provisioning it at install/upgrade time removes
 * that question entirely rather than depending on how replication treats a row for an unknown table.
 *
 * Only the primary key is declared here. The `expiresAt` TTL attribute is not expressible through
 * CreateTableObject, so tokenExchange.ts layers it on with an unconditional `table()` call — the
 * same two-step hdb_certificate_cache uses.
 */
async function createHdbOidcTokenUseIfMissing() {
	if (databases.system?.[OIDC_TOKEN_USE_TABLE]) {
		hdbLogger.info(`system.${OIDC_TOKEN_USE_TABLE} already exists; skipping create.`);
		await patchIsHashAttribute(OIDC_TOKEN_USE_TABLE);
		return;
	}

	hdbLogger.info(`Creating system.${OIDC_TOKEN_USE_TABLE} table for OIDC replay protection.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[OIDC_TOKEN_USE_TABLE];
	if (!schema) {
		throw new Error(`systemSchema.${OIDC_TOKEN_USE_TABLE} is missing; cannot run 5.3.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, OIDC_TOKEN_USE_TABLE);
	const createTable = new (CreateTableObject as any)(
		terms.SYSTEM_SCHEMA_NAME,
		OIDC_TOKEN_USE_TABLE,
		schema.hash_attribute
	);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	// Must match `"audit": true` in systemSchema.json — and here auditing is not cosmetic: it is the
	// replication change feed, without which replay protection would be node-local.
	createTable.audit = true;

	await bridge.createTable(OIDC_TOKEN_USE_TABLE, createTable);
	await patchIsHashAttribute(OIDC_TOKEN_USE_TABLE);
}

async function createHdbOidcTrustIfMissing() {
	if (databases.system?.[OIDC_TRUST_TABLE]) {
		hdbLogger.info(`system.${OIDC_TRUST_TABLE} already exists; skipping create.`);
		await patchIsHashAttribute(OIDC_TRUST_TABLE);
		return;
	}

	hdbLogger.info(`Creating system.${OIDC_TRUST_TABLE} table for OIDC trusted publishing.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[OIDC_TRUST_TABLE];
	if (!schema) {
		throw new Error(`systemSchema.${OIDC_TRUST_TABLE} is missing; cannot run 5.3.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, OIDC_TRUST_TABLE);
	const createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, OIDC_TRUST_TABLE, schema.hash_attribute);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	// Must match `"audit": true` in systemSchema.json, or the fresh-install and upgrade paths diverge.
	createTable.audit = true;

	await bridge.createTable(OIDC_TRUST_TABLE, createTable);
	await patchIsHashAttribute(OIDC_TRUST_TABLE);
}

/**
 * Ensure a table's __dbis__ primary-key entry carries is_hash_attribute: true.
 *
 * harperdb@4.x reads is_hash_attribute from __dbis__ to derive the LMDB DBI open flags; without it
 * the DBI is opened with the opposite flags (DUPSORT set) and LMDB throws MDB_INCOMPATIBLE, breaking
 * downgrade — the same guard 5-1-0.ts and 5-2-0.ts apply to their tables. Both tables created here
 * go through the identical CreateTableObject + bridge.createTable path, so both need it; exempting
 * one would be a silent asymmetry rather than a decision. Idempotent: no-op when already set.
 */
async function patchIsHashAttribute(tableName: string) {
	const systemTable = (databases as any).system?.[tableName];
	if (!systemTable?.dbisDB) return;

	const dbiName = `${tableName}/`;
	const primaryAttr = systemTable.dbisDB.getSync(dbiName);
	if (!primaryAttr || primaryAttr.is_hash_attribute) return; // already correct

	primaryAttr.is_hash_attribute = true;
	await systemTable.dbisDB.put(dbiName, primaryAttr);
	hdbLogger.info(
		`Patched system.${tableName} __dbis__ entry with is_hash_attribute=true for harperdb@4.x downgrade compatibility.`
	);
}

const directive530 = {
	version: '5.3.0',
	description: 'create system.hdb_oidc_trust and system.hdb_oidc_token_use tables for OIDC trusted publishing',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbOidcTrustIfMissing, createHdbOidcTokenUseIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive530];
