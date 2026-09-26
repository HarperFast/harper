'use strict';

// 5.4.0 — introduces system.hdb_model_decisions and system.hdb_model_outcomes for durable
// decisions and their recorded outcomes (#2840).
//
// Fresh installs get both tables from json/systemSchema.json; this covers existing installs. The
// version must match the release that ships `models.recordOutcome` — see 5-1-0.ts for what happens
// when it does not, and DESIGN.md "System table bootstrap" for the three touchpoints. If this code
// ships in 5.3.0 instead, these functions move into 5-3-0.ts.
//
// Only the primary key is declared here. The attributes and the indexed `expiresAt` TTL are not
// expressible through CreateTableObject, so resources/models/decisionStore.ts layers them with an
// unconditional `table()` call at boot on every node — the same two-step as hdb_oidc_token_use,
// declared at boot rather than on first use so the TTL exists on nodes that never decide.

import { databases } from '../../resources/databases.ts';
import systemSchema from '../../json/systemSchema.json';
import * as terms from '../../utility/hdbTerms.ts';
import * as initPaths from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import bridge from '../../dataLayer/harperBridge/harperBridge.ts';
import hdbLogger from '../../utility/logging/harper_logger.ts';

const DECISIONS_TABLE = terms.SYSTEM_TABLE_NAMES.MODEL_DECISIONS_TABLE_NAME;
const OUTCOMES_TABLE = terms.SYSTEM_TABLE_NAMES.MODEL_OUTCOMES_TABLE_NAME;

async function createSystemTableIfMissing(tableName: string, purpose: string) {
	if (databases.system?.[tableName]) {
		hdbLogger.info(`system.${tableName} already exists; skipping create.`);
		await patchIsHashAttribute(tableName);
		return;
	}

	hdbLogger.info(`Creating system.${tableName} table for ${purpose}.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[tableName];
	if (!schema) {
		throw new Error(`systemSchema.${tableName} is missing; cannot run 5.4.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, tableName);
	const createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, tableName, schema.hash_attribute);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	// Must match `"audit": true` in systemSchema.json: auditing is the replication feed, and both
	// tables replicate so an outcome can be recorded through any node.
	createTable.audit = true;

	await bridge.createTable(tableName, createTable);
	await patchIsHashAttribute(tableName);
}

async function createHdbModelDecisionsIfMissing() {
	await createSystemTableIfMissing(DECISIONS_TABLE, 'durable model decisions');
}

async function createHdbModelOutcomesIfMissing() {
	await createSystemTableIfMissing(OUTCOMES_TABLE, 'recorded decision outcomes');
}

/**
 * Ensure a table's __dbis__ primary-key entry carries is_hash_attribute: true, the same guard
 * 5-1-0.ts, 5-2-0.ts and 5-3-0.ts apply to their tables: harperdb@4.x derives the LMDB DBI open
 * flags from it, and without it a downgrade opens the DBI with the wrong flags. Idempotent.
 */
async function patchIsHashAttribute(tableName: string) {
	const systemTable = (databases as any).system?.[tableName];
	if (!systemTable?.dbisDB) return;

	const dbiName = `${tableName}/`;
	const primaryAttr = systemTable.dbisDB.getSync(dbiName);
	if (!primaryAttr || primaryAttr.is_hash_attribute) return;

	primaryAttr.is_hash_attribute = true;
	await systemTable.dbisDB.put(dbiName, primaryAttr);
	hdbLogger.info(
		`Patched system.${tableName} __dbis__ entry with is_hash_attribute=true for harperdb@4.x downgrade compatibility.`
	);
}

const directive540 = {
	version: '5.4.0',
	description: 'create system.hdb_model_decisions and system.hdb_model_outcomes tables for durable decisions',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbModelDecisionsIfMissing, createHdbModelOutcomesIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive540];
