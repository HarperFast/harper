'use strict';

// 5.2.0 — introduces system.hdb_secret for the encrypted secrets store (#715).
//
// Fresh installs get the table automatically via utility/mount_hdb.ts (which iterates
// json/systemSchema.json on first boot). This directive handles the upgrade path: existing
// installs that already have a system schema need the new table added explicitly.
//
// IMPORTANT: this directive must be versioned to the first release that ships the secrets-store
// operations depending on the table. Directives only run when
// current_version < directive_version <= upgrade_version (see
// directivesController.getVersionsForUpgrade), so tagging it for a later release than the
// dependent code means it never fires and the table is missing on upgraded installs
// (see the mis-tagging history documented in 5-1-0.ts).

import { databases } from '../../resources/databases.ts';
import systemSchema from '../../json/systemSchema.json';
import * as terms from '../../utility/hdbTerms.ts';
import * as initPaths from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import bridge from '../../dataLayer/harperBridge/harperBridge.ts';
import hdbLogger from '../../utility/logging/harper_logger.ts';

const SECRET_TABLE = terms.SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME;

async function createHdbSecretIfMissing() {
	if (databases.system?.[SECRET_TABLE]) {
		hdbLogger.info(`system.${SECRET_TABLE} already exists; skipping create.`);
		// Still run the catalog patch (see patchHdbSecretIsHashAttribute).
		await patchHdbSecretIsHashAttribute();
		return;
	}

	hdbLogger.info(`Creating system.${SECRET_TABLE} table for the secrets store.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[SECRET_TABLE];
	if (!schema) {
		throw new Error(`systemSchema.${SECRET_TABLE} is missing; cannot run 5.2.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, SECRET_TABLE);
	const createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, SECRET_TABLE, schema.hash_attribute);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	createTable.audit = true;

	await bridge.createTable(SECRET_TABLE, createTable);
	await patchHdbSecretIsHashAttribute();
}

/**
 * Ensure the hdb_secret __dbis__ primary-key entry carries is_hash_attribute: true.
 *
 * harperdb@4.x reads is_hash_attribute from __dbis__ to derive the LMDB DBI open flags; without
 * it the DBI is opened with the opposite flags (DUPSORT set) and LMDB throws MDB_INCOMPATIBLE,
 * breaking downgrade — the exact failure patchHdbDeploymentIsHashAttribute() in 5-1-0.ts guards
 * hdb_deployment against. Idempotent: no-op when the field is already set.
 */
async function patchHdbSecretIsHashAttribute() {
	const systemTable = (databases as any).system?.[SECRET_TABLE];
	if (!systemTable?.dbisDB) return;

	const dbiName = `${SECRET_TABLE}/`;
	const primaryAttr = systemTable.dbisDB.getSync(dbiName);
	if (!primaryAttr || primaryAttr.is_hash_attribute) return; // already correct
	primaryAttr.is_hash_attribute = true;
	await systemTable.dbisDB.put(dbiName, primaryAttr);
	hdbLogger.info(
		`Patched system.${SECRET_TABLE} __dbis__ entry with is_hash_attribute=true for harperdb@4.x downgrade compatibility.`
	);
}

const directive520 = {
	version: '5.2.0',
	description: 'create system.hdb_secret table for the secrets store',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbSecretIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive520];
