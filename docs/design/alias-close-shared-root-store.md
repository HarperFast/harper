# Close one database alias without tearing down the store its other aliases share

Trigger: `Unit Test` on HarperFast/harper `main` went red on the Node.js v22 and v26 legs with
exit 139 (SIGSEGV) in the "Unit tests: lmdb" step, inside the
`unitTests/resources/databaseAliasIdentity.test.js` suite added by
[#2683](https://github.com/HarperFast/harper/pull/2683) — runs
[35646369634](https://github.com/HarperFast/harper/actions/runs/35646369634) (after test 1) and
[35648838471](https://github.com/HarperFast/harper/actions/runs/35648838471) (after test 2, both
legs). Node.js v24 was green both times.

## The invariant this change enforces

> **A physical root store's native handles are released by the last database name that references
> them, never by the first.** Two names that resolve to one path (a configured alias plus the
> generic scan, or two configured aliases) share one root store object; closing one name may only
> drop that name's registration.

## Root cause (traced on `origin/main` @ `56511db95`)

`resources/databases.ts`:

- `readMetaDb` (`:937-942`) caches LMDB root stores per path in `lmdbDatabaseEnvs`, so every
  database name resolving to that path gets the same `rootStore` object. `readRocksMetaDb` does the
  same through `rocksdbDatabaseEnvs`.
- `initStores` (`:1230`) opens each name's table handles with `rootStore.openDB(...)`: lmdb-js
  returns a new `LMDBStore` per call (`node_modules/lmdb/open.js`, `openDB`), each wrapping the same
  `MDB_dbi` in its own native `DbiWrap`.
- `closeDatabase` (`:2086-2136`) closes the name's table handles (`:2118`), then the root store
  (`:2123` — lmdb-js `env.close()` → `mdb_env_close`, which frees the `MDB_env`), with no check for
  another loaded name still referencing that root store.
- Closing the second name then runs `DbiWrap::close` → `mdb_dbi_close(env, dbi)` against the freed
  environment (`node_modules/lmdb/src/dbi.cpp:88`, `mdb.c:12718`): a use-after-free whose outcome
  depends on allocator state, which is why it hit v22/v26 only and moved by one test between runs.

Reproduced deterministically with glibc's allocator perturbation, 3/3 runs, on this branch's base:

```
MALLOC_PERTURB_=165 HARPER_STORAGE_ENGINE=lmdb npx mocha unitTests/resources/databaseAliasIdentity.test.js
  ✔ keeps the generic-scan identity when a configured alias reconciles the same store
free(): invalid pointer
Aborted (core dumped)
```

gdb backtrace under the same command: `mdb_dbi_close (env=…, dbi=4)` ← `DbiWrap::close` ←
`Napi::InstanceWrap<DbiWrap>::InstanceMethodCallbackWrapper`.

RocksDB does not crash because rocksdb-js refcounts column-family handles process-wide, but the same
sequence still flips the shared root object's `status` to `closed`, unregisters its storage
reclamation handler, and drops the env-cache entry while the other name is still serving reads
(probed on both engines: after closing name A, name B's `get` returns the record under RocksDB and
throws `Can not renew a transaction from a closed database` under LMDB).

The defect predates #2683, whose core change is identity only (`rootStore.databaseName ??=`); its
tests are the first to close two names of one store in sequence under LMDB.

**Producers of the sequence in production.** `closeDatabase` has one non-test caller:
`server/itc/serverHandlers.js:53`, the `restore_backup` ITC broadcast, which closes the named
database on every thread. With a configured alias of the same path, that is exactly this sequence.
`closeLoadedDatabases` (`:2155`, worker-exit teardown) also walks every loaded name but only for
RocksDB, where it reaches the same shared-root bookkeeping.

## Approaches considered

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Make lmdb-js safe against it: have `DbiWrap::close` skip `mdb_dbi_close` once its environment is closed.                                                                                                                                                                                                                                                                                                                                                                                    | Rejected. `DbiWrap` holds a raw `MDB_env*` with no liveness signal after `mdb_env_close` (`env.cpp:766`), so this needs a new native env-to-dbi registry plus an lmdb-js release, and it only removes the crash: harper would still close a store another name is reading from (the RocksDB probe above shows the same broken state without any native fault). Harper creates the sharing (`lmdbDatabaseEnvs`), so harper owns the invariant. |
| **Deeper cause**    | Stop sharing: open one environment per database name instead of caching per path.                                                                                                                                                                                                                                                                                                                                                                                                           | Rejected. LMDB forbids opening the same file twice in one process (`mdb_env_open` caveats; lmdb-js's `envTracking` exists to hand every opener of a path one `MDB_env`), and #2683's blob-path stability depends on the names sharing one root store identity.                                                                                                                                                                                |
| **Do less**         | Change the test: close only one alias, or skip the suite under LMDB.                                                                                                                                                                                                                                                                                                                                                                                                                        | Rejected. The two-name close is reachable in production through the `restore_backup` ITC handler on every worker of any deployment with a configured alias, so the test is exercising a shipped path, not a harness artifact.                                                                                                                                                                                                                 |
| **Chosen**          | `closeDatabase` checks whether each of the name's root stores is still referenced by another loaded name (any other `databases` entry's table, or another `definedDatabases` entry). If so it drops only the name's registration. Per-name RocksDB column-family handles still close with the name (each open is its own refcount); LMDB table handles are environment-wide (`mdb_dbi_close` invalidates the slot for every wrapper), so they close with the environment, at the last name. | The only option that keeps the surviving name serving reads on both engines, keeps RocksDB refcounts balanced (a name's opens are matched by that name's closes), and needs no dependency change. `mdb_dbi_close` is optional by LMDB's contract, so leaving the first name's LMDB handles to the environment close is not a leak.                                                                                                            |

## Change

`resources/databases.ts` — `closeDatabase`:

- Collect the name's root stores as today; for each, decide `shared` by scanning the other loaded
  names' tables and the other defined-database entries for the same root store object.
- Not shared: unchanged — stop audit cleanup, close table and index handles, close `dbisDb` and the
  root store, unregister storage reclamation, drop the env-cache entry.
- Shared: skip every root-store step; close the name's table and index handles only when the root
  store is RocksDB; always drop the name from `databases` and clear its defined-database `rootStore`.

`unitTests/resources/databaseAliasIdentity.test.js` — one new test, runs under both engines:
load two names of one store, close the first, assert the shared root store is still `open` and the
second name still reads a record written through the first, close the second, assert the root store
is `closed`. On base the first assertion fails on both engines (the root's status flips on the first
close), so the mechanism proof does not depend on allocator luck; the perturbed run above is the
crash-level check.

## Verification route

- Fails-on-base: the new test against the base `dist`, and the `MALLOC_PERTURB_` run above on base
  (aborts) versus the fix (passes).
- Unit gates: `test:unit:resources` under RocksDB and under `HARPER_STORAGE_ENGINE=lmdb`, plus
  `test:unit:main`, on Node 26 (the CI leg that failed).
- End to end: not observable end-to-end in the integration suite — the production trigger is the
  `restore_backup` ITC broadcast on a deployment with a configured alias, which no integration
  fixture configures. The unit test drives `closeDatabase` itself, which is the whole path that
  handler takes.
