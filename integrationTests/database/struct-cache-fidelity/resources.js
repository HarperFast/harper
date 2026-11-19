// QA-181 — confirm the structon typedStructs cap SATURATES at 256 in-worker, using
// the EXACT deterministic shape generator the fidelity test drives over HTTP.
//
// Why a custom resource (the QA-175 lesson): an HTTP `insert` does NOT necessarily
// encode on the HTTP worker that received it (the write is encoded on the store path),
// so reading `encoder.typedStructs.length` from the HTTP worker after an insert reads
// an encoder that never saw those records. To deterministically CONFIRM the cap
// saturated at 256 during a key-set-heterogeneous load, we drive `encoder.encode()`
// IN-WORKER over the same shapes and read the live typedStructs count + growth trace.
//
// The shape generator below is byte-for-byte the same logic the test uses to build the
// records it writes over HTTP (makeRecord), so the typedStructs growth we observe here
// is the growth the real write path produces — and shapes #257..#500 are precisely the
// post-cap-saturation records whose fidelity the test then verifies via read-back.

// ---- deterministic shape generator (MUST match the test's makeRecord) ----------------
// Shape i selects a field-NAME subset from a large pool; field VALUES are derived from
// (id, fieldName) so the expected record is recomputable. Shape index advances every
// record, so a NEW distinct field-set keeps appearing well past 256 — saturating the cap
// partway through and then continuing to mint records on the post-cap fallback path.
const POOL_SIZE = 90; // attribute-name pool: f0..f89
function fieldName(j) {
	return 'f' + j;
}
// value for (id, fieldName) — deterministic + type-varied so a wrong-decode is visible.
function fieldValue(id, j) {
	const kind = j % 5;
	if (kind === 0) return id * 1000 + j; // small int
	if (kind === 1) return `s_${id}_${j}`; // string
	if (kind === 2) return id % 2 === 0; // boolean
	if (kind === 3) return (id + j) * 0.5 + 0.125; // float
	return id * 1_000_000_000 + j; // large int (> 32-bit)
}
// Field-set for shape index `s`: a deterministic subset of the pool. We rotate a window
// over the pool and vary its size so distinct field-NAME sets keep appearing for >256
// distinct shapes (window start * size combinations >> 256 with POOL_SIZE=90).
function shapeFields(s) {
	const size = 3 + (s % 11); // 3..13 fields
	const start = (s * 7) % POOL_SIZE; // rotating window start
	const stride = 1 + (s % 3); // 1..3 — varies which names land in the set
	const fields = [];
	const seen = new Set();
	for (let k = 0; k < size; k++) {
		const j = (start + k * stride) % POOL_SIZE;
		if (seen.has(j)) continue;
		seen.add(j);
		fields.push(j);
	}
	return fields;
}
// Build record for shape index `idx` (idx === shape index, so shape #257 == idx 257).
// The stored primary key `id` is a STRING (the `id: ID` column requires string keys);
// the numeric idx still drives the deterministic field-set + values.
function makeRecord(idx) {
	const rec = { id: String(idx) };
	for (const j of shapeFields(idx)) rec[fieldName(j)] = fieldValue(idx, j);
	return rec;
}

// EncodeProbe: drive the inner randomAccess store's encoder over the same shapes and
// report typedStructs growth + the configured cap. Confirms saturation at 256.
// GET /CapEncodeProbe/?count=600
export class CapEncodeProbe extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const count = Number((query.get && query.get('count')) || 600);
		const table = tables.CapFidelity;
		let store = table && table.primaryStore;
		let enc = store && store.encoder;
		// walk to the store whose encoder is on the randomAccess typed path
		let s = store;
		for (let i = 0; i < 4 && s; i++) {
			if (s.randomAccessStructure && s.encoder) {
				enc = s.encoder;
				store = s;
				break;
			}
			s = s.store || s.db || s._store || null;
		}
		if (!enc || typeof enc.encode !== 'function') return { error: 'no encoder' };
		const before = Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null;
		const trace = [];
		let firstCapHit = null; // record id at which typedStructs first reached the cap
		const cap = enc.maxOwnStructures ?? null;
		for (let idx = 0; idx < count; idx++) {
			try {
				enc.encode(makeRecord(idx));
			} catch {
				/* ignore — fidelity is measured via the real round-trip, not here */
			}
			const len = Array.isArray(enc.typedStructs) ? enc.typedStructs.length : -1;
			if (firstCapHit === null && cap != null && len >= cap) firstCapHit = idx;
			if (idx % Math.max(1, Math.floor(count / 12)) === 0) trace.push(len);
		}
		const after = Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null;
		trace.push(after);
		return {
			storeCtor: store && store.constructor && store.constructor.name,
			randomAccessStructure: store ? (store.randomAccessStructure ?? null) : null,
			maxOwnStructures: cap,
			typedStructsBefore: before,
			typedStructsAfter: after,
			firstCapHit, // the shape/id where the cap first saturated — records after this are post-cap
			growthTrace: trace,
			encoded: count,
			pid: process.pid,
		};
	}
}
