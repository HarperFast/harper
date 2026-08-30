import { DEFAULT_DATABASE_NAME } from '../utility/hdbTerms.ts';

/**
 * Refuse a table declaration that would land in the BASE of a database this application branched.
 *
 * `table()` registers in the process-wide catalog, so a branched application declaring a table --
 * through GraphQL `@table`, `scope.ensureTable`, or `defineTable` -- would create it in the base:
 * replicated, visible to every other application, and bound to this application's own routes, while
 * its JavaScript read and wrote the branch. Refusing is temporary; making these land in the branch
 * is harper#2264. Databases this application did not branch are untouched.
 */
export function assertTableTargetNotBranched(
	branches: Map<string, unknown> | undefined,
	databaseName: string | undefined | null,
	tableName: string,
	how: string
): void {
	if (!branches?.size) return;
	// Falsy, not nullish: `table()` resolves every falsy name to the default database, so a guard that
	// only defaulted null and undefined would let `database: ''` past the fence and then land in the
	// base as `data`.
	const target = databaseName || DEFAULT_DATABASE_NAME;
	if (!branches.has(target)) return;
	const error: any = new Error(
		`Cannot declare table '${tableName}' in branched database '${target}' through ${how}: it would be created ` +
			`in the base database's schema rather than in this application's branch`
	);
	error.statusCode = 400;
	throw error;
}
