/**
 * A component operation runs on a worker thread, so invoking it forwards the whole request —
 * including `hdb_user.role.permission` — through `postMessage`, which structured-clones it. That is
 * the path a `Proxy`-backed system permission map broke with `DataCloneError` (harper#2120).
 */
import { isMainThread } from 'node:worker_threads';

server.registerOperation({
	name: 'system_authz_probe',
	execute: async function systemAuthzProbe(op) {
		const systemTables = op.hdb_user?.role?.permission?.system?.tables ?? {};
		return {
			executedOnMainThread: isMainThread,
			username: op.hdb_user?.username ?? null,
			// Proves the permissions survived the clone with their contents intact, not merely that
			// the request arrived.
			sawSystemTables: Object.keys(systemTables).length,
			statusReadable: systemTables.hdb_status?.read ?? null,
			statusInsertable: systemTables.hdb_status?.insert ?? null,
		};
	},
});
