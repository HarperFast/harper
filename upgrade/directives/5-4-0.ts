'use strict';

// 5.4.0 — registers the system-table attributes `json/systemSchema.json` gained after each table was created,
// such as `activated_from` on `hdb_deployment`. The general rule for adding an attribute to an existing
// system table is in dataLayer/DESIGN.md, "System table bootstrap".

import * as terms from '../../utility/hdbTerms.ts';
import { createSystemTableIfMissing } from './5-3-0.ts';
import { registerSystemSchemaAttributes } from '../systemSchemaAttributes.ts';

async function createHdbNetworkAccessIfMissing() {
	await createSystemTableIfMissing(terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME, 'network access allowlists');
}

const directive540 = {
	version: '5.4.0',
	description:
		'create system.hdb_network_access for per-scope source address allowlists, and register system-table attributes added since each table was created',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbNetworkAccessIfMissing, registerSystemSchemaAttributes] as Array<() => Promise<unknown>>,
};

export default [directive540];
