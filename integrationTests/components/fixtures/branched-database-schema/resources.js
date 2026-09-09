/**
 * Fixture for harper#2264: an application that declared `branchedDatabases: [data]` and declares
 * its own table in schema.graphql.
 *
 * It reads and writes `databases.data.<table>` exactly as an unbranched application would — the
 * scoped binding the loader hands it is what redirects those names, and the `@table` declaration
 * lands in the same branch that binding resolves.
 *
 * The `import` is load-bearing. A branch is delivered through the module loader's `harper` exports,
 * so the bare `databases` global — which `vm-current-context` shares process-wide and cannot scope —
 * would resolve to the BASE and this application would silently share the database it asked to fork.
 */
import { databases, server } from 'harper';

server.registerOperation({
	name: 'branch_probe',
	execute: async function branchProbe(op) {
		const Table = databases.data[op.table ?? 'Branched'];
		if (op.action === 'put') {
			await Table.put({ id: op.id, note: op.note });
			return { wrote: op.id };
		}
		const record = await Table.get(op.id);
		return { found: record != null, note: record?.note ?? null };
	},
});
