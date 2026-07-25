// QA-738 — cache-sourced (sourcedFrom) Blob x TTL-expiration fixture.
//
// PageCache.sourcedFrom() resolver: on every call it returns a NEW deterministic 200KB blob
// (seeded by id + a per-id monotonic call counter), so successive revalidations are always
// content-different and independently byte-verifiable (no dependence on server-generated
// randomness the test can't recompute).
//
// /Stats/ is a side-channel POST resource (not part of the cache-read path under test) used to:
//   - setDelay: make the NEXT resolver call for an id artificially slow, to widen the race
//     window for in-flight-during-expiry / stampede probes.
//   - callCount: read how many times the resolver actually ran for an id (single-flight check).
//   - reconcile: server-side scan of every LIVE PageCache record, independent of the REST path,
//     comparing stored bytes against the stored sha256.

import { createHash, createHmac, randomBytes } from 'node:crypto';

const { PageCache, ResolverCalls } = tables;

const BLOB_SIZE = 200 * 1024; // well above the 8192B file-storage threshold

function patternBuffer(seed, size) {
	const out = Buffer.allocUnsafe(size);
	let off = 0;
	let counter = 0;
	while (off < size) {
		const block = createHmac('sha256', String(seed)).update(String(counter++)).digest();
		const n = Math.min(block.length, size - off);
		block.copy(out, off, 0, n);
		off += n;
	}
	return out;
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// Best-effort shared call counter + one-shot delay via ResolverCalls (see schema.graphql
// comment): NOT strictly atomic under concurrent callers on the SAME id (read-modify-write can
// race), so under a genuine stampede this may undercount by a little — acceptable, it is only a
// measurement aid. The actual "did more than one revalidation really happen" invariant is
// Harper's own single-flight lock (resources/Table.ts:5311-5316, primaryStore.tryLock), not this
// counter. Byte-content uniqueness (the real correctness oracle) does NOT depend on this counter
// being exact — see the random nonce below.
async function claimResolverCall(id) {
	const existing = await ResolverCalls.get(id);
	const count = (existing?.count || 0) + 1;
	const delayMs = existing?.delayMs || 0;
	await ResolverCalls.put({ id, count, delayMs: null }); // increment + consume any one-shot delay
	return { count, delayMs };
}

PageCache.sourcedFrom(
	class extends Resource {
		async get() {
			const id = this.getId();
			const { count: n, delayMs } = await claimResolverCall(id);
			if (delayMs) {
				await new Promise((r) => setTimeout(r, delayMs));
			}
			// Nonce guarantees content differs on every call regardless of the (best-effort,
			// non-atomic) counter above, so the correctness oracle never depends on the counter.
			const nonce = randomBytes(8).toString('hex');
			const data = patternBuffer(`${id}:origin-v${n}:${nonce}`, BLOB_SIZE);
			return {
				id,
				data: createBlob(data, { type: 'application/octet-stream' }),
				version: n,
				sha256: sha256hex(data),
			};
		}
	}
);

// POST /Stats/ { action, id, ms? }
export class Stats extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		const id = body && String(body.id);
		switch (action) {
			case 'setDelay': {
				const existing = await ResolverCalls.get(id);
				await ResolverCalls.put({ id, count: existing?.count || 0, delayMs: Number(body.ms) || 0 });
				return { ok: true, id, ms: Number(body.ms) || 0 };
			}

			case 'callCount': {
				const existing = await ResolverCalls.get(id);
				return { ok: true, id, count: existing?.count || 0 };
			}

			case 'reconcile': {
				let total = 0;
				let intact = 0;
				let mismatched = 0;
				let readError = 0;
				const bad = [];
				for await (const rec of PageCache.search({})) {
					total++;
					try {
						const bytes = Buffer.from(await rec.data.bytes());
						const sha = sha256hex(bytes);
						if (sha === rec.sha256) {
							intact++;
						} else {
							mismatched++;
							bad.push({ id: rec.id, expected: rec.sha256, got: sha, len: bytes.length });
						}
					} catch (e) {
						readError++;
						bad.push({ id: rec.id, error: String((e && e.message) || e) });
					}
				}
				return { ok: true, total, intact, mismatched, readError, bad: bad.slice(0, 10) };
			}

			default:
				return { ok: false, reason: 'unknown-action', action };
		}
	}
}
