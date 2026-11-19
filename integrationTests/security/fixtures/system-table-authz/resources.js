import { isMainThread } from 'node:worker_threads';

server.registerOperation({
	name: 'system_authz_probe',
	execute: async function systemAuthzProbe(op) {
		const systemTables = op.hdb_user?.role?.permission?.system?.tables ?? {};
		return {
			executedOnMainThread: isMainThread,
			username: op.hdb_user?.username ?? null,
			sawSystemTables: Object.keys(systemTables).length,
			statusReadable: systemTables.hdb_status?.read ?? null,
			statusInsertable: systemTables.hdb_status?.insert ?? null,
		};
	},
});
