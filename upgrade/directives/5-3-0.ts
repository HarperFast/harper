'use strict';

// 5.3.0 — introduces system.hdb_oidc_trust for OIDC trusted publishing (#2171).
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

async function createHdbOidcTrustIfMissing() {
	if (databases.system?.[OIDC_TRUST_TABLE]) {
		hdbLogger.info(`system.${OIDC_TRUST_TABLE} already exists; skipping create.`);
		await patchHdbOidcTrustIsHashAttribute();
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
	await patchHdbOidcTrustIsHashAttribute();
}

/**
 * Ensure the hdb_oidc_trust __dbis__ primary-key entry carries is_hash_attribute: true.
 *
 * harperdb@4.x reads is_hash_attribute from __dbis__ to derive the LMDB DBI open flags; without it
 * the DBI is opened with the opposite flags (DUPSORT set) and LMDB throws MDB_INCOMPATIBLE, breaking
 * downgrade — the same guard 5-1-0.ts and 5-2-0.ts apply to their tables. Idempotent: no-op when the
 * field is already set.
 */
async function patchHdbOidcTrustIsHashAttribute() {
	const systemTable = (databases as any).system?.[OIDC_TRUST_TABLE];
	if (!systemTable?.dbisDB) return;

	const dbiName = `${OIDC_TRUST_TABLE}/`;
	const primaryAttr = systemTable.dbisDB.getSync(dbiName);
	if (!primaryAttr || primaryAttr.is_hash_attribute) return; // already correct

	primaryAttr.is_hash_attribute = true;
	await systemTable.dbisDB.put(dbiName, primaryAttr);
	hdbLogger.info(
		`Patched system.${OIDC_TRUST_TABLE} __dbis__ entry with is_hash_attribute=true for harperdb@4.x downgrade compatibility.`
	);
}

const directive530 = {
	version: '5.3.0',
	description: 'create system.hdb_oidc_trust table for OIDC trusted publishing',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbOidcTrustIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive530];
