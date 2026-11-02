# SQL engine v2

## LIKE: one tokenizer, linear matcher

`tokenizeLike` (`expressions/like.ts`) is the only definition of a v2 LIKE pattern: literal characters, `_` (one character), `%` (any run); the `ESCAPE` character, checked before the wildcards, makes the next character literal. Every consumer calls it: `normalizeLike` (`parser/normalizer.ts`) to validate, `compileExpr` to build the row matcher, and `leafToCondition` (`optimizer/whereToConditions.ts`) to build index conditions. A pushed index condition replaces the row filter with no re-check, so a second reading of the pattern selects or deletes the wrong rows: before [#3878](https://github.com/HarperFast/harper/issues/3878), the index rewrite read `'t0!%' ESCAPE '!'` as `starts_with 't0!'`.

- The index rewrite works on tokens: a pattern maps to `equals`/`starts_with`/`ends_with`/`contains` only when every token other than one leading and one trailing `%` is a literal, and the condition value is the unescaped literal.
- Malformed patterns (a trailing escape, an `ESCAPE` that is not one character) fail in the normalizer with `EngineRuntimeError`. Later, `validateScannable` would turn the query into an `EngineUnsupportedError`, and `auto` would run it on legacy instead.
- `compileLikeTokens` never backtracks: `%` splits the pattern into fixed-width segments, the first and last are anchored, and each middle segment takes its leftmost fit after the previous one. A segment is matched by `indexOf`/`startsWith`, or by a RegExp with no quantifier or alternation, which cannot backtrack; cost is O(value × pattern). A whole-pattern RegExp is not an option: separated `%` runs backtrack polynomially (`'%_%_…%_Z'` blocked a worker, [#1930](https://github.com/HarperFast/harper/issues/1930)), and V8's linear engine is an experimental flag that Bun lacks. `unitTests/sqlEngine/like.test.js` bounds the cost in a child process.
- Matching is case-sensitive and per UTF-16 code unit; `%` and `_` match line terminators.
