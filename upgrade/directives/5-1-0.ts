'use strict';

// 5.1.0 — introduces system.hdb_deployment for deployment tracking.
//
// Fresh installs get the table automatically via utility/mount_hdb.ts (which iterates
// json/systemSchema.json on first boot). This directive handles the upgrade path: existing
// installs that already have a system schema need the new table added explicitly.
//
// IMPORTANT: this directive must be versioned to the first release that ships the
// deployment-recorder code depending on the table (5.1.0), NOT a later release. Directives
// only run when current_version < directive_version <= upgrade_version (see
// directivesController.getVersionsForUpgrade). Tagging it for a later release than the
// dependent code (it was previously mis-tagged 5.2.0) means it never fires on the
// 5.0.x -> 5.1.x upgrade path, leaving the table missing and replicated deploy_component
// failing on peer nodes.

import { databases } from '../../resources/databases.ts';
import systemSchema from '../../json/systemSchema.json';
import * as terms from '../../utility/hdbTerms.ts';
import * as initPaths from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import bridge from '../../dataLayer/harperBridge/harperBridge.ts';
import hdbLogger from '../../utility/logging/harper_logger.ts';

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

async function createHdbDeploymentIfMissing() {
	if (databases.system?.[DEPLOYMENT_TABLE]) {
		hdbLogger.info(`system.${DEPLOYMENT_TABLE} already exists; skipping create.`);
		// Still run the patch — installs that created hdb_deployment before the is_hash_attribute
		// fix was introduced have an __dbis__ entry without that field. harperdb@4.x uses
		// is_hash_attribute to determine LMDB DBI open flags; without it the DBI is opened with
		// wrong flags (DUPSORT set) and LMDB throws MDB_INCOMPATIBLE, breaking downgrade.
		await patchHdbDeploymentIsHashAttribute();
		return;
	}

	hdbLogger.info(`Creating system.${DEPLOYMENT_TABLE} table for deployment tracking.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[DEPLOYMENT_TABLE];
	if (!schema) {
		throw new Error(`systemSchema.${DEPLOYMENT_TABLE} is missing; cannot run 5.1.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, DEPLOYMENT_TABLE);
	const createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, DEPLOYMENT_TABLE, schema.hash_attribute);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	createTable.audit = true;

	await bridge.createTable(DEPLOYMENT_TABLE, createTable);
}

/**
 * Patch the hdb_deployment __dbis__ primary-key entry to include is_hash_attribute: true.
 *
 * harperdb@4.x reads is_hash_attribute from __dbis__ to derive the LMDB DBI open flags
 * (DBIDefinition(dup_sort, is_hash_attribute)). If the field is absent it opens the DBI
 * with dup_sort=true / useVersions=false — the opposite of how harper@5 created it — which
 * causes LMDB to throw MDB_INCOMPATIBLE and prevents harperdb@4 from starting after a
 * 5.1.x downgrade.
 *
 * This is safe to call when the table already exists: it is a no-op if is_hash_attribute is
 * already set, and writing it back is idempotent (lmdb upsert).
 */
async function patchHdbDeploymentIsHashAttribute() {
	const systemTable = (databases as any).system?.[DEPLOYMENT_TABLE];
	if (!systemTable?.dbisDB) return;

	const dbiName = `${DEPLOYMENT_TABLE}/`;
	const primaryAttr = systemTable.dbisDB.getSync(dbiName);
	if (!primaryAttr || primaryAttr.is_hash_attribute) return; // already correct

	primaryAttr.is_hash_attribute = true;
	await systemTable.dbisDB.put(dbiName, primaryAttr);
	hdbLogger.info(
		`Patched system.${DEPLOYMENT_TABLE} __dbis__ entry with is_hash_attribute=true for harperdb@4.x downgrade compatibility.`
	);
}

const directive510 = {
	version: '5.1.0',
	description: 'create system.hdb_deployment table for deployment tracking',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbDeploymentIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive510];
