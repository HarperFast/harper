/**
 * Fixture for harper#643: an application that declared `branchedDatabases`.
 *
 * It reads and writes `databases.<name>.Branched` exactly as an unbranched application would — the
 * scoped binding the loader hands it is what redirects those names. `database` defaults to `data`
 * so the single-database isolation test can omit it; the `true` (branch-everything) test passes it
 * explicitly to reach whichever database it is probing.
 *
 * The `import` is load-bearing. A branch is delivered through the module loader's `harper` exports,
 * so the bare `databases` global — which `vm-current-context` shares process-wide and cannot scope —
 * would resolve to the BASE and this application would silently share the database it asked to fork.
 */
import { databases, server } from 'harper';

server.registerOperation({
	name: 'branch_probe',
	execute: async function branchProbe(op) {
		const { Branched } = databases[op.database ?? 'data'];
		if (op.action === 'put') {
			await Branched.put({ id: op.id, note: op.note });
			return { wrote: op.id };
		}
		const record = await Branched.get(op.id);
		return { found: record != null, note: record?.note ?? null };
	},
});
