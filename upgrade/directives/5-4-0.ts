'use strict';

// 5.4.0 — system.hdb_network_access for existing installs; fresh installs get it from json/systemSchema.json
// (dataLayer/DESIGN.md, "System table bootstrap").

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
