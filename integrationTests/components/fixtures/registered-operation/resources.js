/**
 * Fixture for #1736: `server.registerOperation()` from a component's resources.js.
 *
 * resources.js loads per HTTP worker thread, so these registrations land in worker-local
 * OPERATION_FUNCTION_MAP instances. The cross-thread bridge must make them reachable through
 * the main-thread ops-API dispatcher.
 */
import { isMainThread, threadId } from 'node:worker_threads';
import { Readable } from 'node:stream';

server.registerOperation({
	name: 'component_registered_echo',
	// Named function expression so the handler's `.name` is deterministic for the
	// verifyPerms/requiredPermissions lookup (not inferred as "execute").
	execute: async function componentRegisteredEcho(op) {
		return {
			echoed: op.value ?? null,
			executedOnMainThread: isMainThread,
			executedOnThreadId: threadId,
			username: op.hdb_user?.username ?? null,
		};
	},
});

server.registerOperation({
	name: 'component_registered_stream',
	execute: async function componentRegisteredStream() {
		return Readable.from(['streamed ', 'result']);
	},
});

server.registerOperation({
	name: 'component_registered_error',
	execute: async function componentRegisteredError() {
		const error = new Error('deliberate failure from component operation');
		error.statusCode = 422;
		throw error;
	},
});

server.registerOperation({
	name: 'component_registered_grantable',
	requiresSuperUser: true,
	execute: async function componentRegisteredGrantable(op) {
		return {
			granted: true,
			executedOnMainThread: isMainThread,
			executedOnThreadId: threadId,
			username: op.hdb_user?.username ?? null,
		};
	},
});

// Raises the denial `component_registered_grantable` gives an unauthorized caller on this worker
// itself, for comparison with the same denial arriving over the main -> worker forward.
server.registerOperation({
	name: 'component_registered_denial_probe',
	requiresSuperUser: false,
	execute: async function componentRegisteredDenialProbe(op) {
		try {
			await server.operation({ operation: 'component_registered_grantable' }, { user: op.hdb_user }, true);
			return { denied: false };
		} catch (error) {
			return { denied: true, statusCode: error.statusCode, body: error.http_resp_msg };
		}
	},
});
