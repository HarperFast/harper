# Preserve missing values in nested projections

Status: draft; planning alternative adopted; native fix implemented; full validation and outside-family code review pending.

Keep the native single-record projection API and preserve `undefined` and `null` when a nested relationship has no record. Read each selected value once and recurse only for objects, matching Table search projection. Guard nullish inputs in each of `Resource.transformForSelect`'s three returned transforms before accessing `.then`; promise-resolved nullish values receive the same treatment through recursion.

**Invariant:** projecting a missing value preserves its exact absence value; selecting an existing value preserves the current projection shape.

## Design assessment

No new API, schema, configuration, or storage format. This changes shared Resource projection behavior used by Table.get and protocol dispatch, so the core shared-behavior planning gate applies. Preserve the existing distinction between `undefined` and `null`; keep outer `forceNulls` handling and relationship permission admission unchanged. No performance improvement is claimed.

## Evidence

- **Observed:** base [fbb5ed381328cc66bd54d4cecdbaa97c20d520ff](https://github.com/HarperFast/harper/commit/fbb5ed381328cc66bd54d4cecdbaa97c20d520ff), freshly fetched from `origin/main`, fails the new regression with **3 passing, 15 failing**. Present scalar/object/positional relationship projections pass; absent, explicit-null, and orphaned foreign keys fail with `Cannot read properties of undefined/null (reading 'then')`.
- **Verified source trace:** [Table.get](resources/Table.ts) lines 3493–3497 calls `transformForSelect` on a real loaded record. The scalar relationship resolver at lines 8257–8285 returns a nullish foreign key unchanged or an absent lookup as `undefined`. [Resource.transformForSelect](resources/Resource.ts) lines 1231–1232 passes that value into the nested transform, whose `.then` access is unguarded in all three forms (1179, 1187, 1198).
- **Observed route:** [regression test](unitTests/resources/nestedSelectMissingValues.test.js) uses real tables, RocksDB storage, RequestTarget, inherited static Resource.get transaction wrapper, and nested relationship resolution. Helper promise-input cases are defense in depth, not a claim that native foreign keys produce promise-valued targets. After implementation, **23 cases pass on RocksDB and LMDB**, including mixed present/orphan arrays, present controls, promises, primitive pass-through, and outer `forceNulls`.
- **Existing tracking:** [REST ?select projection crashes (500) on missing to-one relationship target and sub-select on non-relationship field](https://github.com/HarperFast/harper/issues/1415), locus A, matches this defect. Locus B constructs a sub-transform with no target table and fails while reading `resource.propertyResolvers`. The adopted value-first gate passes nullish/primitive selected values through, but object-valued non-relationship selectors remain unqualified and out of scope. Do not close the combined issue from this narrow fix.
- **Verified version boundary:** installed Riot Ridge Harper reports 5.3.2 and contains the same unguarded transform; the fresh core base reports 5.3.1. These are separate source trees, not proof of a release fix.

Reproduce in this worktree:

```sh
npm run build
node node_modules/mocha/bin/mocha.js unitTests/resources/nestedSelectMissingValues.test.js --timeout 5000
```

The initial shared-dependency build failed because `@inquirer/*` packages were absent. **Observed repair:** replace only this worktree's dependency symlink with `npm ci --no-audit --no-fund --allow-remote=root`; `npm run build` then passes, and the regression repeats **3 passing, 15 failing** on the clean built distribution. Shared dependencies are unchanged. npm 12 blocks several dependency install scripts by default; the projection regression runs, but optional native-module readiness remains to verify before full gates.

## Approaches considered

| Axis            | Candidate                                                                                              | Decision fact                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different layer | Guard Table.get relationship values before calling shared projection.                                  | Custom Resource callers and promise-resolved values also use the shared transform; a Table-only guard leaves those confirmed nullish entry paths broken.    |
| Deeper cause    | Require every foreign key to name a present record.                                                    | Optional foreign keys legitimately contain `null` or are absent; referential enforcement would change write contracts and existing data semantics.          |
| Do less         | Keep callers on bounded search projection, whose separate implementation guards missing relations.     | Existing native get and REST select users still hit this crash. Search remains the application compatibility path until a fixed core artifact is qualified. |
| Chosen          | Read the selected value once, recurse only for objects, and guard all three nullish transform entries. | Matches search projection value gating and covers all three forms and recursive promise resolution, with no data rewrite or API change.                     |

**Resolution:** the value-first gate avoids constructing a target-table transform for missing/primitive values; the three entry guards also cover missing array members and promise resolution. Full get/search projection consolidation is deferred: search consumes entry objects and table-specific read transactions plus join/filter/sort inputs, while this helper consumes selected values. Replacing both pipelines crosses those distinct contracts to fix this nullish defect. The planning review adopted this refinement over guards alone.

## Verification and open items

- **Observed end-to-end:** [existing relationship integration](integrationTests/resources/relationship-and-status-contract.test.ts) passes **17/17**, requiring HTTP 200 for the formerly tolerated orphan failure and checking absent/null/orphan targets through nested GET in JSON and MessagePack. No live Riot preview is required.
- Run the required full unit/resource/integration, lint, formatting, mechanical, and outside-family review gates after implementation; rebuild after the source change. Confirm optional native-module readiness in the isolated dependency environment first.
- **Observed baseline limitation:** type-strip testing fails before the regression loads, both here and in a detached worktree at the exact base with equivalent dependencies: `ERR_IMPORT_ATTRIBUTE_MISSING` for `json/systemSchema.json`, imported by unchanged `security/user.ts`. The normal built-native tests pass; this type-strip gate remains red.
- **Observed baseline limitation:** `applicationSpawn.test.js` on the exact base reports 20 passing and a 15-second timeout in “terminates a detached process tree when its owning worker is force-terminated.” Full-main execution stalled at the same test; its isolated harness child was terminated to let the remaining gate progress. That interrupted run cannot be a clean passing gate.
- Outside code review and full gates remain pending; object-valued non-relationship selector handling stays out of scope.

Sources: linked base commit, current Resource/Table source and regression above, and the existing upstream issue body. No GitHub mutations performed.
