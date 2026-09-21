# Close one database alias without tearing down the store its other aliases share

Trigger: `Unit Test` on HarperFast/harper `main` went red on the Node.js v22 and v26 legs with
exit 139 (SIGSEGV) in the "Unit tests: lmdb" step, inside the
`unitTests/resources/databaseAliasIdentity.test.js` suite added by
[#2683](https://github.com/HarperFast/harper/pull/2683) — runs
[35646369634](https://github.com/HarperFast/harper/actions/runs/35646369634) (after test 1) and
[35648838471](https://github.com/HarperFast/harper/actions/runs/35648838471) (after test 2, both
legs). Node.js v24 was green both times.

Revision 2 — planning round 1 returned `better-alternative-exists`; what was adopted is recorded in
[Planning round 1](#planning-round-1-resolution).

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

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Make lmdb-js safe against it: have `DbiWrap::close` skip `mdb_dbi_close` once its environment is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rejected. `DbiWrap` holds a raw `MDB_env*` with no liveness signal after `mdb_env_close` (`env.cpp:766`), so this needs a new native env-to-dbi registry plus an lmdb-js release, and it only removes the crash: harper would still close a store another name is reading from (the RocksDB probe above shows the same broken state without any native fault). Harper creates the sharing (`lmdbDatabaseEnvs`), so harper owns the invariant. |
| **Deeper cause**    | Stop sharing: open one environment per database name instead of caching per path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rejected. LMDB forbids opening the same file twice in one process (`mdb_env_open` caveats; lmdb-js's `envTracking` exists to hand every opener of a path one `MDB_env`), and #2683's blob-path stability depends on the names sharing one root store identity.                                                                                                                                                                                |
| **Do less**         | Change the test: close only one alias, or skip the suite under LMDB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rejected. The two-name close is reachable in production through the `restore_backup` ITC handler on every worker of any deployment with a configured alias, so the test is exercising a shipped path, not a harness artifact.                                                                                                                                                                                                                 |
| **Chosen**          | Two operations with different lifetimes. `closeDatabase(name)` is the logical release: it retires the name's table runtimes (`Table.cleanup()`), closes the RocksDB column-family handles the name opened (each open is its own refcount), drops the name's registration, and tears the root store down only when no other loaded name references it. LMDB table handles are never closed individually: `mdb_dbi_close` invalidates the environment-wide slot for every wrapper of it and is optional by LMDB's contract, so the environment close at the last name releases them. `closeDatabaseWithAliases(name)` is the physical close — every loaded name sharing a root store with `name` — and is what the `restore_backup` ITC handler now calls. | The only option that keeps the surviving name serving reads on both engines, keeps RocksDB refcounts balanced, leaves restore able to reach a physically closed store under any alias, and needs no dependency change.                                                                                                                                                                                                                        |

## Change

`resources/databases.ts`:

- `closeDatabase(name)` — logical release, as described in _Chosen_. Root-store teardown (audit
  cleanup stop, storage-reclamation unregistration, `dbisDb` and root close, env-cache entry) runs
  only when no other loaded name references the root store. `closeStore` also attaches a rejection
  handler to a promise-returning close (lmdb-js's), which the synchronous try/catch never saw.
- `closeDatabaseWithAliases(name)` — physical close: awaits the derived-index runtime stop of every
  table under every loaded name sharing a root store with `name` (the runtime's stop barrier is the
  proof that nothing can still write), then closes those names, so the last close releases the native
  handles with no flush in flight.
- `collectRootStores(name)` / `isRootStoreReferencedElsewhere` — the per-name root-store set (tables
  plus the defined-database entry for a tableless name), compared by object identity, never by path.

`server/itc/serverHandlers.js`: the `restore_backup` ITC handler calls `closeDatabaseWithAliases`
so a restore of an aliased database reaches `verifyDatabaseClosed` with the store actually closed.

`unitTests/resources/databaseAliasIdentity.test.js`, both engines unless noted:

- Close either alias first: the removed name's `Table.cleanup()` ran once, the shared root store is
  still `open`, the surviving name reads a record written through the other, and the last close
  leaves the root `closed` with no `refCount > 0` entry in rocksdb-js's registry (RocksDB).
- `closeDatabaseWithAliases` on one name removes both and closes the store.
- `closeLoadedDatabases` (RocksDB only, as it is by design) with two names releases the store.
- A child process (`databaseAliasIdentity-close.js`) closes two names in either order under
  `MALLOC_PERTURB_=165` and must exit 0: on base it dies with `free(): invalid pointer`, so the
  crash-level check is deterministic on glibc rather than allocator luck (other allocators ignore the
  variable, so the test still passes there).

## Verification route

- Fails-on-base: with `origin/main`'s `databases.ts` and `serverHandlers.js` built into `dist`, the
  two close-order tests and the physical-close test fail on both engines (cleanup count 0, root
  `closed`/`closing` after the first close), and the child-process test fails under LMDB with
  `free(): invalid pointer`; all pass with the fix.
- Unit gates: `test:unit:resources` under RocksDB and under `HARPER_STORAGE_ENGINE=lmdb`, plus
  `test:unit:main`, on Node 26 (the CI leg that failed).
- End to end: not observable end-to-end in the integration suite — the production trigger is the
  `restore_backup` ITC broadcast on a deployment with a configured alias, which no integration
  fixture configures. The unit test drives `closeDatabaseWithAliases` and checks the same registry
  predicate `verifyDatabaseClosed` polls (`dataLayer/rocksdbBackup.ts:628`); an integration fixture
  for aliased online restore is recorded as a follow-up.

## Planning round 1 resolution

Verdict: `better-alternative-exists`. The reviewer's design separated a logical name release from a
physical store close, retired each removed name's table runtime, and dropped explicit LMDB child
handle closes.

**Adopted**

- **Physical close for restore.** The first draft left the `restore_backup` ITC handler on
  `closeDatabase(name)`, which under the new semantics would leave the store open under its other
  names, and `verifyDatabaseClosed` would 409 (`dataLayer/rocksdbBackup.ts:624-640`). Base has the
  same outcome today by a different route (the other name's column-family handles were never
  closed), so this is a fix, not a regression avoided. `closeDatabaseWithAliases` added and used
  there.
- **`Table.cleanup()` on logical release.** Base never retired a closed name's timers, delete
  callbacks, reclamation handler, or derived-index runtime (`resources/Table.ts:7044-7052`); they
  merely observed a closed root. With the root staying open for the other name they would keep
  running against it, so the release now calls `cleanup()` per table.
- **No individual LMDB handle closes.** The first draft kept `mdb_dbi_close` on the last-name path.
  It is optional, environment-wide, and unsafe while any other wrapper of the slot can still be
  referenced, so LMDB handles now close only with the environment.
- **Async close rejections.** lmdb-js's `close()` returns a promise; `closeStore` now attaches a
  rejection handler instead of catching only synchronous throws.
- **Runtime stop before the stores close** (raised in code review rounds 1–2). `Table.cleanup()`
  starts the derived-index runtime's stop without awaiting it, so a flush in flight could land after
  the stores closed — and, for a restore, after the files were replaced. `closeDatabase` stays
  synchronous (worker-exit teardown cannot await), but the physical close awaits every affected
  runtime's stop first, and the ITC handler awaits the physical close.
- **Tests.** Either close order, the physical close, worker-exit teardown, the registry predicate,
  and a perturbed child process, per the _Change_ section.

**Not adopted**

- **End-to-end aliased `restore_backup` integration test.** Real work outside this fix's scope
  (an integration fixture with a configured alias); recorded as a follow-up finding. The unit test
  checks the same registry predicate restore polls.
- **Tableless-alias test.** Two configured names at a path with no tables are two `.mdb` files under
  LMDB (`resources/databases.ts:1945`), not one shared store, so the case is not constructible
  there; the `definedDatabases` branch is covered by code reading, not a test.
