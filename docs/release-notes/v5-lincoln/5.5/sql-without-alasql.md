---
section: SQL
---

### SQL No Longer Depends on AlaSQL

Harper now parses SQL and runs the legacy engine's statements with its own code instead of the AlaSQL package. That covers `sql.engine: legacy` and the statements the default `auto` engine [falls back on](/reference/v5/operations-api/sql#the-fallback-contract). Results are unchanged: the new code returns what AlaSQL returned. Installs are about 10 MB smaller: AlaSQL and the 13 packages only it used are gone.

A few statements AlaSQL ran now fail:

- SQL that evaluates a JavaScript expression, written between double backticks, which only a super user could run, returns a 400 error. An INSERT or SET value that is only such an expression is still stored as its text, as before.
- A request whose second statement is not a `SELECT`, `INSERT`, `UPDATE` or `DELETE`, such as `SELECT 1; DROP TABLE dev.dog`, returns a 400 error. Harper ran the first statement and ignored the rest. A request whose only statement is of another kind is now a 400 parse error as well.
- SQL that AlaSQL could read only by silently dropping words while recovering from a syntax error returns a 400 error. For example, AlaSQL ran `SELECT MIN(DISTINCT right, show.id) FROM dev.dog` as `SELECT MIN(DISTINCT show.id) FROM dev.dog`.
- The `__ala__()` and `OBJECT_ID()` functions are removed, and a call to a name that every JavaScript object inherits, such as `toString(name)`, no longer runs that inherited method. Either fails as an unknown function.

GROUP BY, DISTINCT and joins now treat a value that names a JavaScript object property, such as `constructor` or `toString`, like any other value. AlaSQL returned wrong results for those values or failed the query.
