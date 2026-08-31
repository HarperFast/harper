// NAPI smoke test: build with `cargo build --release --features napi --lib`, then
// (the bench bin cannot link against unresolved node-api symbols; build the lib alone)
//   cp target/release/libhnsw_plane.so hnsw-plane.node && node smoke.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Plane } = require('./hnsw-plane.node');

const dims = 64;
const path = `/tmp/smoke-${process.pid}.hnsw`;
const plane = Plane.create(path, dims, 32, 10_000);

function vec(i) {
	const v = new Float32Array(dims);
	for (let d = 0; d < dims; d++) v[d] = Math.sin(i * 0.37 + d * 1.13) * 0.1 + (d % 7 === i % 7 ? 1 : 0);
	return v;
}

const ids = [];
for (let i = 0; i < 2000; i++) ids.push(plane.insert(vec(i)));
console.log('inserted 2000, highWater =', plane.idHighWater());

// async search: nearest neighbor of an inserted vector is itself (distance ~0)
const hits = await plane.search(vec(42), 5, 128);
console.log('top hit:', hits[0]);
if (hits[0].distance > 1e-3) throw new Error('self-query failed');

// filtered search: allow only even ids
const bitset = new Uint8Array(Math.ceil(plane.idHighWater() / 8));
for (const id of ids) if (id % 2 === 0) bitset[id >> 3] |= 1 << (id & 7);
const filtered = await plane.search(vec(43), 5, 128, bitset);
for (const h of filtered) if (h.id % 2 !== 0) throw new Error(`filter leak: id ${h.id}`);
console.log('filtered top hit:', filtered[0]);

// delete + reinsert reuses the id (the #2182 fix)
plane.remove(ids[7]);
const reused = plane.insert(vec(9001));
if (reused !== ids[7]) throw new Error(`expected id reuse of ${ids[7]}, got ${reused}`);
console.log('freelist reuse OK, highWater still', plane.idHighWater());

// pipelined JS predicate: admit only ids divisible by 3; verdicts computed on the JS
// event loop while traversal runs on the libuv pool
let predicateCalls = 0;
const pred = await plane.searchWithPredicate(vec(44), 5, 128, (ids) => {
	predicateCalls++;
	return Uint8Array.from(ids, (id) => (id % 3 === 0 ? 1 : 0));
});
for (const h of pred) if (h.id % 3 !== 0) throw new Error(`predicate leak: id ${h.id}`);
if (pred.length === 0) throw new Error('predicate search returned nothing');
console.log(`predicate top hit: id ${pred[0].id} (calls: ${predicateCalls})`);

// raw mirroring path (dual-write phase 1): host-allocated ids, full node state per call
const mirror = Plane.create(`/tmp/smoke-mirror-${process.pid}.hnsw`, dims, 32, 10_000);
const q42 = vec(42);
// quantize like the host: scale maps max|c| to 127, invMag = 1/|v|
function quant(v) {
	let maxAbs = 0,
		magSq = 0;
	for (const x of v) {
		maxAbs = Math.max(maxAbs, Math.abs(x));
		magSq += x * x;
	}
	const scale = maxAbs === 0 ? 1 : maxAbs / 127;
	const bytes = Buffer.from(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x / scale)))).buffer);
	return { bytes, scale, invMag: 1 / Math.sqrt(magSq) };
}
// two nodes linked to each other, host ids 10 and 20; node 10 is the entry at level 1
const a = quant(q42),
	b = quant(vec(43));
mirror.writeNodeRaw(10, 1, a.bytes, a.scale, a.invMag, Uint32Array.from([20]), [Uint32Array.from([])]);
mirror.writeNodeRaw(20, 0, b.bytes, b.scale, b.invMag, Uint32Array.from([10]), null);
mirror.setEntryPoint(10, 1);
const mhits = mirror.searchSync(q42, 2, 16);
if (mhits[0].id !== 10 || mhits[0].distance > 1e-3)
	throw new Error(`mirror self-query failed: ${JSON.stringify(mhits)}`);
mirror.clearNode(20);
const mhits2 = mirror.searchSync(vec(43), 2, 16);
if (mhits2.some((h) => h.id === 20)) throw new Error('cleared node still returned');
console.log('raw mirroring OK');

plane.flush();
const reopened = Plane.open(path);
const hits2 = reopened.searchSync(vec(42), 5, 128);
if (hits2[0].distance > 1e-3) throw new Error('reopened self-query failed');
console.log('reopen + sidecar OK. smoke PASSED');
