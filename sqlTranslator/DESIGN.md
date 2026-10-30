# SQL translation

## CommonJS date functions

`alasqlFunctionImporter.ts` imports the CommonJS date-helper object by default; native namespace imports did not expose its object-literal properties in [#562](https://github.com/HarperFast/harper/pull/562). `unitTests/sqlTranslator/alasqlFunctionImporter.test.js` verifies the registered date functions in both test runtimes.

## SQL authorization attributes every column with the engine's own resolution rules (`sql_statement_bucket.ts`, `sqlEngine/binder/columnScope.ts`)

`verifyPermsAST` checks attribute permissions only for the attributes `sqlStatementBucket` records per table, and it runs once, before the router picks legacy or v2, so the bucket alone decides what every engine may read. A column the bucket misses, or records against the wrong table, is read unchecked.

So the bucket attributes columns with the binder's own rules, which live in `columnScope.ts` and are called by `bind.ts`, `logical/build.ts` and the bucket alike:

- A qualified column is attributed only when exactly one table in the statement (not only the tables an ON has joined so far) has the qualifier as its alias or base name. v2 prefers an alias over a base name, while legacy SQL matches either, so only then do both engines read the same table. Any other qualifier is reported by `getUnresolvedColumnRefs()`, and non-super statements are refused.
- An unqualified column in a join goes to every in-scope table that declares it. Each JOIN ON only sees the tables joined so far. If no table declares the column, it stays on the FROM table, where a role with attribute permissions is refused because the attribute is not found.
- `USING (c)` records `c` on the joined table and on `usingLeftOwner` (the nearest preceding declarer, else FROM): the same two operands v2 compares.
- When the registry cannot describe a table, unqualified and USING columns go to every candidate table, so the check fails closed.
- UPDATE and DELETE also need `read` on every column their WHERE or SET expressions read (`getWriteStatementReads()`), separately from the write permission. The primary key is exempt: the statement reports the keys it touched, as NoSQL update and delete do.
- An unqualified `*` in a join expands to the FROM table's readable attributes qualified by its alias, so each expanded name binds to the table whose permissions chose it rather than to whichever table declares it.
- Every walk uses `astNodes()`: iterative, with no depth limit, and visiting shared nodes once. `recursive-iterator` silently stopped at depth 100, so a column nested in 80 function calls went unchecked, and it threw on the subquery node AlaSQL shares between `where` and `exists`.

Row accessors that name no column, AlaSQL's `_` and JavaScript expressions, are refused for non-super users by `getRowAccessors()`. Legacy SQL's row container always carries the primary key (`dataLayer/SQLSearch.ts` keys rows by it), so a whole-row read would expose it whatever the role allows. The JavaScript refusal stays unconditional for non-super users, even if the `_` refusal is ever relaxed for roles without attribute permissions.

Enforced by `unitTests/sqlTranslator/column-attribution.test.js`, `unitTests/sqlEngine/columnScope.test.js` and `integrationTests/security/sql-attribute-perms.test.ts`.
