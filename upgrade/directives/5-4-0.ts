'use strict';

// 5.4.0 — introduces system.hdb_network_access, the per-scope source allowlists published in UDS mirror
// socket metadata (#3358). Fresh installs get the table from json/systemSchema.json; this covers existing
// installs. See DESIGN.md "System table bootstrap" for the three touchpoints.

import * as terms from '../../utility/hdbTerms.ts';
import { createSystemTableIfMissing } from './5-3-0.ts';

async function createHdbNetworkAccessIfMissing() {
	await createSystemTableIfMissing(terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME, 'network access allowlists');
}

const directive540 = {
	version: '5.4.0',
	description: 'create system.hdb_network_access for per-scope source address allowlists',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [createHdbNetworkAccessIfMissing] as Array<() => Promise<unknown>>,
};

export default [directive540];
