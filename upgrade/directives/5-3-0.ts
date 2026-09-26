'use strict';

// 5.3.0 — introduces system.hdb_oidc_trust and system.hdb_oidc_token_use for OIDC trusted
// publishing (#2171).
//
// Fresh installs get both tables from json/systemSchema.json; this covers existing installs, and the
// replay table's full shape is also declared on every boot (security/authn/oidc/tokenUseTable.ts). The
// version must match the release that ships the dependent operations — see 5-1-0.ts for what
// happens when it does not, and DESIGN.md "System table bootstrap" for the three touchpoints.

import { databases } from '../../resources/databases.ts';
import systemSchema from '../../json/systemSchema.json';
import * as terms from '../../utility/hdbTerms.ts';
import * as initPaths from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import bridge from '../../dataLayer/harperBridge/harperBridge.ts';
import hdbLogger from '../../utility/logging/harper_logger.ts';
import { declareTokenUseTable } from '../../security/authn/oidc/tokenUseTable.ts';

const OIDC_TRUST_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME;
const OIDC_TOKEN_USE_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TOKEN_USE_TABLE_NAME;

/**
 * Not skipped when the table exists: the node that upgrades second can already hold a copy its
 * pre-upgrade replication handshake created from a peer, which carries attribute names but not the
 * table's expiration.
 */
async function declareHdbOidcTokenUse() {
	if (!databases.system?.[OIDC_TOKEN_USE_TABLE]) {
		hdbLogger.info(`Creating system.${OIDC_TOKEN_USE_TABLE} table for OIDC replay protection.`);
		initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, OIDC_TOKEN_USE_TABLE);
	}
	declareTokenUseTable();
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
 * downgrade — the same guard 5-1-0.ts and 5-2-0.ts apply to their tables, so both tables here get it.
 * Idempotent: no-op when already set.
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
	async_functions: [createHdbOidcTrustIfMissing, declareHdbOidcTokenUse] as Array<() => Promise<unknown>>,
};

export default [directive530];
