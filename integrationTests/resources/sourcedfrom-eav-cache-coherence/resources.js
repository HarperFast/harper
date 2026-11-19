// QA-595 — cache-sourced Product view assembled from EAV Attribute rows.
//
// Product.sourcedFrom's get() is the seam under test: it reads the 5 known Attribute
// rows for an entity ONE AT A TIME (deterministic key order), so a concurrent
// attribute-by-attribute burst mutation has a real window to land BETWEEN two of those
// reads. `readDelayMs` (set via POST /Control) widens that window on demand for the
// deterministic invalidate-race probe; it defaults to 0 (no artificial delay) for the
// natural-conditions bulk race hunt.
import { setTimeout as sleep } from 'node:timers/promises';

const { Attribute, Product } = tables;

export const ATTR_NAMES = ['name', 'price', 'color', 'stock', 'description'];

let readDelayMs = 0;
let fillCounter = 0;
const fillLog = [];

Product.sourcedFrom(
	class extends Resource {
		async get() {
			const entityId = String(this.getId());
			const fillSeq = ++fillCounter;
			const startedAt = Date.now();
			const attrs = {};
			const gens = {};
			for (const attrName of ATTR_NAMES) {
				const row = await Attribute.get(`${entityId}:${attrName}`);
				attrs[attrName] = row ? row.value : null;
				gens[attrName] = row ? row.gen : null;
				if (readDelayMs > 0) await sleep(readDelayMs);
			}
			const finishedAt = Date.now();
			fillLog.push({ entityId, fillSeq, startedAt, finishedAt });
			return { id: entityId, attrs, gens, fillSeq, assembledAt: finishedAt };
		}
	}
);

/** POST { readDelayMs } — set/clear the artificial per-attribute-read delay inside get(). */
export class Control extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		if (typeof body?.readDelayMs === 'number') readDelayMs = body.readDelayMs;
		return { ok: true, readDelayMs };
	}
}

/** POST { id } — the real, public Table.invalidate(id) API against the cache table. */
export class InvalidateProduct extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const at = Date.now();
		await Product.invalidate(body.id);
		return { ok: true, id: body.id, at };
	}
}

/** GET /FillLog/ — every fill this worker has run (entityId, fillSeq, start/finish ms). */
export class FillLog extends Resource {
	static loadAsInstance = false;
	async get() {
		return fillLog;
	}
}

/** GET /ProductRaw/?id=P3 — the RAW stored Product cache entry (primaryStore.getEntry),
 * bypassing sourcedFrom resolution entirely: no TTL check, no refill-on-miss, no
 * invalidated-row substitution. Used to observe exactly what a fill wrote back without
 * triggering (or masking behind) another fill. */
export class ProductRaw extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const store = Product.primaryStore;
		const entry = store.getEntry(id);
		if (entry == null) return { exists: false, value: null, version: null };
		return { exists: true, value: entry.value, version: entry.version ?? null };
	}
}

/** GET /AttrScan/?id=P3 — independent oracle: raw Attribute rows for one entity, read
 * directly (bypassing Product's cache entirely). */
export class AttrScan extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const out = {};
		for (const attrName of ATTR_NAMES) {
			const row = await Attribute.get(`${id}:${attrName}`);
			out[attrName] = row ? { value: row.value, gen: row.gen } : null;
		}
		return out;
	}
}
