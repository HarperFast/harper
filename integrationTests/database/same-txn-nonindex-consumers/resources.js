// Regression anchor for harper#1970 -- fixture for the same-transaction overwrite chain. Blob
// bytes are a deterministic HMAC stream so every write is a genuine file-backed blob (well above
// the FILE_STORAGE_THRESHOLD) with a verifiable sha256. One HTTP request === one Harper
// transaction (resources/Resource.ts transactional()), which is how ChainWrite puts several
// same-key writes into a single transaction.

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

function getTable(name) {
	// The table lives in its own database (see schema.graphql) so {dataRootDir}/blobs/sametxnblob/
	// holds exclusively this spec's files; `tables` is scoped to the default database.
	const t = databases['sametxnblob'] && databases['sametxnblob'][name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}

function required(body, key) {
	const value = body == null ? undefined : body[key];
	if (value == null) throw new Error(`${key} is required`);
	return value;
}

function requiredSize(op) {
	const size = Number(required(op, 'size'));
	if (!Number.isFinite(size) || size <= 0) throw new Error(`size must be a positive number, got ${op.size}`);
	return size;
}

// POST /Seed/ { table, id, size, seed, tag } -- single write, its own transaction (fully
// committed before the multi-write request under test starts).
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const t = getTable(required(body, 'table'));
		const id = required(body, 'id');
		const buf = patternBuffer(String(required(body, 'seed')), requiredSize(body));
		await t.put({ id, blob: createBlob(buf, { type: 'application/octet-stream' }), tag: body.tag });
		return { ok: true, id, sha: sha256(buf) };
	}
}

// POST /ChainWrite/ { table, id, ops: [{size, seed, tag}, ...] } -- ops.length writes to the SAME
// id inside ONE ambient transaction (this one HTTP request).
export class ChainWrite extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const t = getTable(required(body, 'table'));
		const id = required(body, 'id');
		const ops = required(body, 'ops');
		if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array');
		const shas = [];
		for (const op of ops) {
			const buf = patternBuffer(String(required(op, 'seed')), requiredSize(op));
			shas.push(sha256(buf));
			await t.patch({ id, blob: createBlob(buf, { type: 'application/octet-stream' }), tag: op.tag });
		}
		return { ok: true, id, shas };
	}
}

// GET /VerifyChain/?table=&id= -- post-commit read via a SEPARATE request (LMDB has no
// read-your-writes within a still-open transaction). Also the GET-able readiness probe.
export class VerifyChain extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const table = query.get('table');
		const id = query.get('id');
		if (!table || !id) return { ok: true, present: false, reason: 'table and id query parameters are required' };
		const t = getTable(table);
		const rec = await t.get(id);
		if (!rec || !rec.blob) return { ok: true, present: false, id };
		const bytes = Buffer.from(await rec.blob.bytes());
		return { ok: true, present: true, id, tag: rec.tag, sha: sha256(bytes), size: bytes.length };
	}
}
