'use strict';

// 5.4.0 — registers the system-table attributes `json/systemSchema.json` gained after each table was created,
// such as `activated_from` on `hdb_deployment`. The general rule for adding an attribute to an existing
// system table is in dataLayer/DESIGN.md, "System table bootstrap".

import { registerSystemSchemaAttributes } from '../systemSchemaAttributes.ts';
import { getResidencyMapTable, RESIDENCY_MAP_TABLE } from '../../resources/residencyMaps.ts';

/** Provision existing installs as well as fresh installs; declarations remain safe before an upgrade. */
async function createResidencyMapTable() {
	const Table = getResidencyMapTable();
	const key = `${RESIDENCY_MAP_TABLE}/`;
	const attribute = Table.dbisDB.getSync(key);
	if (attribute && !attribute.is_hash_attribute) {
		// Older LMDB binaries use this bit to choose compatible DBI flags on downgrade.
		await Table.dbisDB.put(key, { ...attribute, is_hash_attribute: true });
	}
}

const directive540 = {
	version: '5.4.0',
	description: 'register new system-table attributes and create system.hdb_residency_slots for sharding',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [registerSystemSchemaAttributes, createResidencyMapTable] as Array<() => Promise<unknown>>,
};

export default [directive540];
