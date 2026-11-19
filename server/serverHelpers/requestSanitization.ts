/**
 * `evaluateSQL` honors a supplied `parsed_sql_object` verbatim and skips parsing, so one carrying
 * `permissions_checked: true` executes an AST that no authorization check ever saw. Neither position
 * is ever legitimately client-supplied: dispatch parses the statement itself, and the job worker
 * re-parses from the `sql` string dispatch authorized.
 *
 * Both positions, because the two entry points differ: `chooseOperation` overwrites the top-level
 * object with its own parse, but only inside its SQL branch, so a non-SQL job (`export_local` with a
 * `search_by_value` search) can still carry a client-supplied one through to the persisted row.
 */
export function stripSuppliedParsedSqlObject(request: any): void {
	if (!request) return;
	delete request.parsed_sql_object;
	delete request.search_operation?.parsed_sql_object;
}
