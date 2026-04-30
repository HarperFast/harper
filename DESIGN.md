# DESIGN.md

Design notes and non-obvious internals for the harper-pro/core codebase. Complements AGENTS.md (architecture overview) and CONTRIBUTING.md. Grows incrementally as agents encounter non-obvious things.

---

## RecordObject prototype and entryMap

Records stored in tables are plain objects given a `RecordObject` prototype, which provides `getExpiresAt()` and `getUpdatedTime()`. These methods read from `entryMap` (a `WeakMap` in `RecordEncoder.ts`), which maps each record object to its storage entry.

- The prototype is set automatically by the msgpack decoder via `structPrototype` (per-table, defined inside `RecordEncoder`).
- `entryMap.set(record, entry)` is called whenever a record is read from the store.
- To give a plain JS object the RecordObject prototype without copying it (preserving mutability), use `Object.setPrototypeOf(obj, primaryStore.encoder.structPrototype)` then `entryMap.set(obj, entry)`.
- Do **not** copy the object (e.g. via `Object.assign` into a new instance) if any code still holds a reference to the original and expects to mutate it — see below.

## getFromSource() timing: promise resolves before commit runs

In `getFromSource()` (`Table.ts`), the promise that callers await resolves with the entry **before** the `dbTxn.addWrite` commit callback runs. The commit callback mutates `updatedRecord` in-place to set fields like `createdAt` and `updatedAt`. Since the resolved entry's `.value` is the same reference as `updatedRecord`, those mutations are visible to the caller after resolution.

Consequence: never replace `entry.value` with a copy of `updatedRecord` in this path — the copy won't receive the commit callback's mutations.
