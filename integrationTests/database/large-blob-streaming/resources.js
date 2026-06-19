// QA-144 — Large-blob storage limits + streaming upload/download correctness.
//
// EVERYTHING is done in bounded chunks so we never hold a whole 256MB+ blob in
// the worker JS heap:
//   - UPLOAD: createBlob(<async generator yielding CHUNK-sized Buffers>) streams
//     the bytes straight to the blob file (writeBlobWithStream). The generator
//     produces a deterministic HMAC-SHA256 keystream so the content is
//     non-compressible and unique per (seed,size), and we can recompute the
//     expected SHA-256 independently — also chunk-by-chunk, never buffered.
//   - DOWNLOAD/VERIFY: read the stored blob via blob.stream() and feed each
//     chunk into a running createHash('sha256'), so the read-back hash is
//     computed without ever materializing the full blob in memory.
//
// If Harper truly streams, the worker heap should stay BOUNDED (a few chunk
// buffers) during both upload and download regardless of blob size. If it
// buffers (e.g. payload.bytes()), heap/rss would balloon ~proportional to size.

import { createHash, createHmac } from 'node:crypto';

const { Big } = tables;

const CHUNK = 4 * 1024 * 1024; // 4MB working chunk — the only large allocation we hold

// Deterministic keystream: block i = HMAC-SHA256(seed, i). Yields CHUNK-sized
// Buffers totalling exactly `size` bytes, generating on the fly (no full buffer).
function* keystreamChunks(seed, size) {
	let produced = 0;
	let counter = 0;
	let pending = Buffer.alloc(0);
	while (produced < size) {
		// Fill up a CHUNK from 32-byte HMAC blocks.
		const want = Math.min(CHUNK, size - produced);
		const parts = [pending];
		let have = pending.length;
		while (have < want) {
			const block = createHmac('sha256', String(seed)).update(String(counter++)).digest();
			parts.push(block);
			have += block.length;
		}
		const joined = Buffer.concat(parts, have);
		const out = joined.subarray(0, want);
		pending = joined.subarray(want); // carry leftover into next chunk
		produced += out.length;
		yield out;
	}
}

// Expected SHA-256 of the (seed,size) pattern, computed chunk-by-chunk.
function expectedSha(seed, size) {
	const h = createHash('sha256');
	for (const c of keystreamChunks(seed, size)) h.update(c);
	return h.digest('hex');
}

export class BlobOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		try {
			switch (body && body.action) {
				case 'store':
					return await this.store(body);
				case 'verify':
					return await this.verify(body);
				case 'delete':
					return await this.del(body);
				case 'expected':
					// Pure server-side expected SHA (chunked) for cross-check.
					return { ok: true, expectedSha: expectedSha(body.seed ?? body.key, Number(body.size)) };
				default: {
					const ctx = this.getContext();
					if (ctx && ctx.response) ctx.response.status = 400;
					return { ok: false, reason: 'unknown-action', action: body && body.action };
				}
			}
		} catch (e) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 500;
			return {
				ok: false,
				error: String(e && e.message),
				stack: String(e && e.stack)
					.split('\n')
					.slice(0, 4),
			};
		}
	}

	// STREAMING UPLOAD: create the blob from an async generator (no full buffer).
	async store(body) {
		const key = String(body.key);
		const seed = body.seed == null ? key : String(body.seed);
		const size = Number(body.size);
		const t0 = Date.now();

		// Async generator so createBlob takes the streaming (Readable.from) path.
		async function* gen() {
			for (const c of keystreamChunks(seed, size)) {
				yield c;
				// yield to the event loop so heap sampling can observe us mid-flight
				await new Promise((r) => setImmediate(r));
			}
		}

		const want = expectedSha(seed, size);
		await Big.put({
			key,
			payload: createBlob(gen(), { type: 'application/octet-stream', size }),
			sha256: want,
			size,
		});

		return { ok: true, key, expectedSha: want, size, uploadMs: Date.now() - t0 };
	}

	// STREAMING VERIFY: read back via blob.stream(), running-hash, never buffered.
	async verify(body) {
		const key = String(body.key);
		const t0 = Date.now();
		const rec = await Big.get(key);
		if (!rec) return { ok: true, present: false, key };

		const blob = rec.payload;
		const h = createHash('sha256');
		let bytesRead = 0;
		// blob.stream() returns a web ReadableStream of Uint8Array chunks.
		const reader = blob.stream().getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytesRead += value.length;
			h.update(value);
		}
		const readSha = h.digest('hex');
		return {
			ok: true,
			present: true,
			key,
			storedSha: rec.sha256,
			storedSize: Number(rec.size),
			readSize: bytesRead,
			readSha,
			match: readSha === rec.sha256 && bytesRead === Number(rec.size),
			verifyMs: Date.now() - t0,
		};
	}

	async del(body) {
		const key = String(body.key);
		await Big.delete(key);
		return { ok: true, key, deleted: true };
	}
}
