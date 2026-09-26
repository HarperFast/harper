// Regression anchor for harper 85f1c4b72 (#2134 reader half) — blob-bearing record writer + raw-byte
// streaming readers for the reader-vs-supersession race. Content is a deterministic HMAC stream so every write is a genuine
// file-backed blob (well above the 8KB FILE_STORAGE_THRESHOLD) and its sha256 is verifiable.

import { createHash, createHmac } from 'node:crypto';

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

function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

const { Asset } = databases.blobreader;

// POST /AssetCtl/ { action: 'store'|'delete', id, size, seed }
// A control-plane resource: writes/deletes Asset records without going through JSON blob encoding.
export class AssetCtl extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		switch (action) {
			case 'store': {
				const id = String(body.id);
				const size = Number(body.size);
				const seed = body.seed == null ? id : String(body.seed);
				const buf = patternBuffer(seed, size);
				await Asset.put({ id, content: createBlob(buf, { type: 'application/octet-stream' }) });
				return { ok: true, id, sha256: sha256(buf), size: buf.length };
			}
			case 'delete': {
				const id = String(body.id);
				await Asset.delete(id);
				return { ok: true, id };
			}
			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}
}

// GET /AssetStream/{id} -- streams the raw blob bytes as the HTTP body (no JSON envelope), the
// pattern a real media-delivery app would use to let clients pull a multi-MB attribute directly.
export class AssetStream extends Asset {
	async get() {
		if (this.content == null) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 404;
			return null;
		}
		return {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
			body: this.content,
		};
	}
}

// GET /AssetLateStream/{id}?delayMs=N -- resolves the record (and its Blob handle) immediately,
// publishes that fact for /AssetLateState/, then waits delayMs BEFORE returning the body. The
// blob file is opened only when the body is streamed, so this separates "record resolved" from
// "file opened" by a controllable gap -- the gap a fixed post-supersession unlink timer cannot
// cover. delayMs is required: a defaulted value would silently run a different experiment.
const lateReads = new Map();
export class AssetLateStream extends Asset {
	async get(query) {
		const raw = query.get('delayMs');
		const delayMs = Number(raw);
		if (raw == null || !Number.isFinite(delayMs) || delayMs < 0)
			throw new Error(`delayMs query parameter is required, got ${raw}`);
		if (this.content == null) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 404;
			return null;
		}
		lateReads.set(String(this.id), 'resolved');
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		lateReads.set(String(this.id), 'streaming');
		return {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
			body: this.content,
		};
	}
}

// GET /AssetLateState/?id= -> { id, state: 'none' | 'resolved' | 'streaming' }
export class AssetLateState extends Resource {
	static loadAsInstance = false;
	get(query) {
		const id = query.get('id');
		return { id, state: lateReads.get(String(id)) ?? 'none' };
	}
}
