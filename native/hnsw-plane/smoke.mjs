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

plane.flush();
const reopened = Plane.open(path);
const hits2 = reopened.searchSync(vec(42), 5, 128);
if (hits2[0].distance > 1e-3) throw new Error('reopened self-query failed');
console.log('reopen + sidecar OK. smoke PASSED');
