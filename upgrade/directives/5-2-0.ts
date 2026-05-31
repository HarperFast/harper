'use strict';

// 5.2.0 — introduces system.hdb_deployment for deployment tracking.
//
// Fresh installs get the table automatically via utility/mount_hdb.ts (which iterates
// json/systemSchema.json on first boot). This directive handles the upgrade path: existing
// installs that already have a system schema need the new table added explicitly.

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
		return;
	}

	hdbLogger.info(`Creating system.${DEPLOYMENT_TABLE} table for deployment tracking.`);

	const CreateTableObject =
		require('../../dataLayer/CreateTableObject').default || require('../../dataLayer/CreateTableObject');
	const schema = (systemSchema as any)[DEPLOYMENT_TABLE];
	if (!schema) {
		throw new Error(`systemSchema.${DEPLOYMENT_TABLE} is missing; cannot run 5.2.0 directive.`);
	}

	initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, DEPLOYMENT_TABLE);
	const createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, DEPLOYMENT_TABLE, schema.hash_attribute);
	createTable.attributes = schema.attributes;
	const primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === schema.hash_attribute);
	if (primaryKeyAttribute) primaryKeyAttribute.isPrimaryKey = true;
	createTable.audit = true;

	await bridge.createTable(DEPLOYMENT_TABLE, createTable);
}

const directive520 = {
	version: '5.2.0',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbDeploymentIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive520];
