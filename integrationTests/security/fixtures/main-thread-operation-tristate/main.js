// SQA-181: three operations registered ONLY on the main thread (loaded through
// HARPER_BUILTIN_COMPONENTS, `startOnMainThread`), one per `requiresSuperUser` declaration shape.
// Workers reach them through the worker -> main forward (PR #4138).
import { isMainThread, threadId } from 'node:worker_threads';

function reply(shape, op) {
	return { shape, isMainThread, threadId, username: op.hdb_user?.username ?? null };
}

export async function startOnMainThread(options) {
	const srv = options?.server ?? globalThis.server;
	srv.registerOperation({
		name: 'sqa181_su',
		requiresSuperUser: true,
		execute: async (op) => reply('su', op),
	});
	srv.registerOperation({
		name: 'sqa181_open',
		requiresSuperUser: false,
		execute: async (op) => reply('open', op),
	});
	// Omitted flag: no central permission entry. The handler keeps a name that differs from the
	// operation name so any denial text shows which key the permission check used.
	srv.registerOperation({
		name: 'sqa181_bare',
		execute: async function sqa181BareHandler(op) {
			return reply('bare', op);
		},
	});
}
