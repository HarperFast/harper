# resources/ — map

Where things are in `resources/`. The rules live in [DESIGN.md](DESIGN.md): read the note before you change code it names. To list the symbols in a file, run `npm run outline -- <file>` where that script exists, or use the LSP tool's document/workspace symbol lookup. `grep -n '#section:' resources/Table.ts` lists the sections of the `makeTable()` factory.

## Files

- `Resource.ts` — base class: static protocol entry points wrapped in `transactional()`, instance methods that subclasses override
- `Table.ts` — `makeTable()` builds each table's `TableResource` class: reads, writes, search, subscribe, validation, residency
- `DatabaseTransaction.ts`, `LMDBTransaction.ts` — engine transactions: staging, commit and retry, the timeout monitor, read snapshots
- `transaction.ts` — `transaction()` scopes and `contextStorage`
- `databases.ts` — catalog loading, `table()`/`declareTable`, index backfill, database close and drop
- `RecordEncoder.ts`, `asBinary.ts` — record metadata encoding, `entryMap`, `RecordObject`
- `PrimaryRocksDatabase.ts`, `RocksIndexStore.ts` — RocksDB primary and index stores
- `RocksTransactionLogStore.ts`, `auditStore.ts` — per-origin transaction logs; audit records, audit floor, database generation
- `replayLogs.ts`, `replayLogsGuards.ts` — crash replay of the transaction logs
- `transactionBroadcast.ts`, `IterableEventQueue.ts` — commit notification fan-out; subscription queues
- `subscriptionCheckpoint.ts`, `originClosedFloor.ts` — per-origin subscription checkpoints; the certified `local` log floor
- `search.ts` — FIQL parsing, condition planning and estimation, index scans, joins
- `blob.ts` — file-backed blobs: saving, compression, cleanup, reclamation
- `tracked.ts`, `crdt.ts` — tracked-instance changes; CRDT operations and history reconstruction
- `Resources.ts`, `RequestTarget.ts`, `jsResource.ts` — the path registry and routes; the parsed request target; registering component exports
- `ResourceInterface.ts` — shared types (`Context`, request body parts)
- `resolveBody.ts`, `staticResourceDispatch.ts`, `ErrorResource.ts`, `login.ts` — body resolution, the false-mode dispatch marker, the error resource, the login endpoint
- `defineTable.ts`, `defineResource.ts`, `jsonSchemaTypes.ts`, `openApi.ts`, `graphql.ts` — code-first tables, request contracts, the JSON Schema IR, OpenAPI output, GraphQL schema compilation
- `residencyPolicy.ts`, `residencyMaps.ts`, `residencyConversion.ts`, `shardingCompleteness.ts`, `databaseLiveGuard.ts` — sharding policy, the slot map, conversion, the owner baseline, live holds
- `nodeIdMapping.ts` — node name ↔ short id
- `recordLock.ts`, `recordLockCoordinator.ts` — record locks; see [record-locks.md](record-locks.md)
- `derivedIndexes.ts`, `derivedIndexRegistry.ts`, `derivedIndexRuntime.ts` — derived indexes: attachment, registration, committed-log delivery; see [indexes/DESIGN.md](indexes/DESIGN.md)
- `fullTextSchema.ts`, `fullTextSchemaLifecycle.ts` — full-text declarations and their persisted state; see [FULL_TEXT.md](FULL_TEXT.md)
- `branchDatabase.ts`, `databaseDropPreparation.ts` — per-application database branches; cross-thread drop preparation
- `longLivedTransactions.ts`, `replicatedApplyFailure.ts` — long-held handle reports; apply-failure listeners
- `loadEnv.ts`, `secretDecryptor.ts` — `.env` loading and `enc:v1:` decryption
- `dataLoader.ts`, `roles.ts` — component data files and role definitions
- `readOnlyMode.ts`, `typeParity.ts`, `registrationDeprecated.ts` — the read-only flag, exact type equality, deprecated registration info
- `analytics/`, `indexes/`, `models/`, `scheduler/` — telemetry, HNSW and full-text indexes, the model facade, the cluster scheduler (each has its own DESIGN.md)

## Where is it

- request authorization → `transactional()` in Resource.ts; `allowRead`/`allowUpdate`/`allowCreate`/`allowDelete` in Table.ts
- versioning, write conflicts, out-of-order merge → `_writeUpdate` in Table.ts
- delete, invalidate, relocate, publish → `_writeDelete`, `_writeInvalidate`, `_writeRelocate`, `_writePublish` in Table.ts
- index choice and condition order → `executeConditions`, `estimateCondition`, `searchByIndex` in search.ts
- FIQL parsing → `parseBlock` in search.ts
- response shape (select) → `transformEntryForSelect` in Table.ts; `transformForSelect` in Resource.ts
- sorting → `transformToOrderedSelect` in Table.ts
- record TTL and eviction → `setTTLExpiration`, `evict`, `scheduleCleanup` in Table.ts
- cache miss to source → `getFromSource` in Table.ts
- subscriptions and replay → `subscribe`, `eventFromAudit` in Table.ts; `addSubscription` in transactionBroadcast.ts
- replication apply loop → `sourcedFrom` in Table.ts
- the per-request transaction → `txnForContext` in Table.ts; `transaction()` in transaction.ts
- transaction timeouts and long-held handles → `startMonitoringTxns` in DatabaseTransaction.ts; longLivedTransactions.ts
- residency, stubs, replicas → `getResidency`, `_storeReplica` in Table.ts; residencyMaps.ts
- table create, schema change, drop → `table()`, `runIndexing` in databases.ts; `dropTable`, `updatedAttributes` in Table.ts
- relationships → the resolvers built in `updatedAttributes`; `_prepareRelationshipSelection` and `_readDenial` in Table.ts
- URL path to resource → `getMatch`, `matchParamRoute` in Resources.ts
- record flags (`INVALIDATED`, `REPLICA`, `VERSION_REUSED`) → RecordEncoder.ts; byte layout in [storage-format.md](../storage-format.md)
- audit floor and retention → auditStore.ts; see [audit-retention.md](audit-retention.md)
- HNSW connectivity after a delete → `repairSeveredNeighbors` in indexes/HierarchicalNavigableSmallWorld.ts
- tests → `unitTests/resources/`
