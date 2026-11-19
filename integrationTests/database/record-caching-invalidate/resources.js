// Backing endpoints for the invalidate() value-shape record-caching test.
//
// getEntry() (resources/PrimaryRocksDatabase.ts) only caches non-null values
// (`entry.value != null`, a separate guard from the typeof-object check). Bare scalar
// (number/string/boolean) root values were the originally-envisioned edge to probe here, but
// they are unreachable through any supported or sandboxed path: Table.ts rejects any
// non-object record at every public write entry point (before a version is staged), and the
// jsLoader security sandbox blocks a component from importing RecordEncoder.ts to bypass
// that validation directly. The internal call sites that DO bypass Table's validation (raw
// primaryStore.put/putSync) also bypass the version-staging path, so they never populate the
// cache regardless of value shape.
//
// The one reachable, fully-versioned, non-object root value via a 100% supported public API
// is `Table.invalidate(id)`: for a table with no @indexed attributes, the write goes through
// the real recordUpdater path (real monotonic version, real INVALIDATED metadata flag) and
// lands a genuinely versioned `null` root value — landing on the same `entry.value != null`
// guard as a real production code path (replication residency loss writes null this way).
import { threadId } from 'node:worker_threads';

const { Widget } = tables;
const store = Widget.primaryStore;

// POST /Invalidate/ { id } -> tables.Widget.invalidate(id): the real, public,
// fully-versioned invalidate API. Writes a real `null` root value for this schema (Widget
// has no @indexed attributes, so no partial-record reconstruction kicks in).
export class Invalidate extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		await Widget.invalidate(body.id);
		return { ok: true, threadId, id: body.id };
	}
}

// GET /WidgetGet/?id=... -> reads through the REAL getEntry() cache path directly against
// primaryStore (bypassing Table's higher-level read semantics, which may apply extra
// handling for invalidated rows) so we observe exactly what the cache layer itself has,
// per worker.
export class WidgetGet extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const entry = store.getEntry(id);
		if (entry == null) {
			return { threadId, id, exists: false, value: null, valueType: 'undefined', version: null };
		}
		const value = entry.value;
		const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		return { threadId, id, exists: true, value, valueType, version: entry.version ?? null };
	}
}
