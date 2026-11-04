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
	readOnly: true,
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: { value: { type: 'string' } },
		required: ['value'],
	},
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

server.registerOperation({
	name: 'component_registered_bad_schema',
	inputSchema: { type: 'object', properties: { value: { $ref: '#/definitions/Missing' } } },
	execute: async function componentRegisteredBadSchema() {
		return { ok: true };
	},
});

server.registerOperation({
	name: 'component_registered_draft_06',
	inputSchema: {
		$schema: 'http://json-schema.org/draft-06/schema#',
		type: 'object',
		properties: { value: { type: 'string' } },
	},
	execute: async function componentRegisteredDraft06(op) {
		return { echoed: op.value };
	},
});

server.registerOperation({
	name: 'component_registered_disagreement',
	inputSchema: { type: 'object', properties: { worker: { const: threadId } } },
	execute: async function componentRegisteredDisagreement() {
		return { threadId };
	},
});

server.registerOperation({
	name: 'component_registered_align_schema',
	execute: async function componentRegisteredAlignSchema() {
		server.registerOperation({
			name: 'component_registered_disagreement',
			inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
			execute: async function componentRegisteredAgreed() {
				return { threadId };
			},
		});
		return { threadId };
	},
});
