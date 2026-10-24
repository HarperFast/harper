'use strict';

// 5.4.0 — registers the system-table attributes `json/systemSchema.json` gained after each table was created,
// such as `activated_from` on `hdb_deployment`. The general rule for adding an attribute to an existing
// system table is in dataLayer/DESIGN.md, "System table bootstrap".

import { registerSystemSchemaAttributes } from '../systemSchemaAttributes.ts';

const directive540 = {
	version: '5.4.0',
	description: 'register system-table attributes added since each table was created',
	sync_functions: [] as Array<() => unknown>,
	async_functions: [registerSystemSchemaAttributes] as Array<() => Promise<unknown>>,
};

export default [directive540];
