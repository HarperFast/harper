// Each POST handler below runs in one ambient transaction (one HTTP request), so repeated
// `table.patch()` calls on one id form a same-key write chain. Every read-back happens in a
// separate request, after the chain's transaction has committed.

import { createHash, createHmac } from 'node:crypto';

function getTable(name) {
	const t = databases.sametxnchain?.[name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}

function requiredId(query) {
	const id = query.get('id');
	if (!id) throw new Error('missing required query parameter "id"');
	return id;
}

function requiredInt(value, name) {
	const n = Number(value);
	if (value == null || !Number.isInteger(n) || n <= 0) throw new Error(`"${name}" must be a positive integer`);
	return n;
}

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

// Which engine backs the tables: LMDB opens its root store at a path ending in `.mdb`, RocksDB at a
// bare directory. Lets the spec assert the engine in effect instead of trusting the env var.
export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get() {
		const store = getTable('Computed').primaryStore;
		const path = store?.path || store?.rootStore?.path || null;
		return { path, engine: typeof path === 'string' && path.endsWith('.mdb') ? 'lmdb' : 'rocksdb' };
	}
}

// ---- @computed via the PATCH merge base ----

export class ComputedSeed extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		await getTable('Computed').put({ id: body.id, a: body.a, b: body.b });
		return { ok: true };
	}
}

// body.ops: [{a} | {b}, ...] -- one PATCH per op, each touching only the field it names.
export class ComputedChainWrite extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		const t = getTable('Computed');
		for (const op of body.ops) {
			const patch = { id: body.id };
			if (op.a !== undefined) patch.a = op.a;
			if (op.b !== undefined) patch.b = op.b;
			await t.patch(patch);
		}
		return { ok: true };
	}
}

export class VerifyComputed extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const id = requiredId(target);
		const rec = await getTable('Computed').get(id);
		if (!rec) return { present: false, id };
		return { present: true, id, a: rec.a, b: rec.b, sum: rec.sum };
	}
}

// ---- two-step chain vs racing single-step writers ----

export class CasSeed extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		await getTable('CasChain').put({ id: body.id, status: 'A', seq: 0, owner: null });
		return { ok: true };
	}
}

// Reads the row, and if it is still A writes LOCKED, waits `delayMs` with the transaction open, then
// writes DONE -- both writes in this request's transaction.
export class CasChainSlow extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		const delayMs = requiredInt(body.delayMs, 'delayMs');
		const t = getTable('CasChain');
		const cur = await t.get(body.id);
		if (cur?.status !== 'A') return { won: false, seenStatus: cur?.status };
		await t.patch({ id: body.id, status: 'LOCKED', seq: cur.seq + 1, owner: body.owner });
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		await t.patch({ id: body.id, status: 'DONE', seq: cur.seq + 2, owner: body.owner });
		return { won: true };
	}
}

// Single-step: if the row is still A, move it to newStatus.
export class CasAttempt extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		const t = getTable('CasChain');
		const cur = await t.get(body.id);
		if (cur?.status !== 'A') return { won: false, seenStatus: cur?.status };
		await t.patch({ id: body.id, status: body.newStatus, seq: cur.seq + 1, owner: body.owner });
		return { won: true };
	}
}

export class VerifyCas extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const id = requiredId(target);
		const rec = await getTable('CasChain').get(id);
		if (!rec) return { present: false, id };
		return { present: true, id, status: rec.status, seq: rec.seq, owner: rec.owner };
	}
}

// ---- blob reclamation across a same-key chain ----

export class BlobSeed extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		const buf = patternBuffer(body.seed, requiredInt(body.size, 'size'));
		await getTable('BlobChain').put({
			id: body.id,
			blob: createBlob(buf, { type: 'application/octet-stream' }),
			tag: body.tag,
		});
		return { sha: sha256(buf) };
	}
}

// body.ops: [{seed, size, tag}, ...] -- one blob-replacing PATCH per op.
export class BlobChainWrite extends Resource {
	static loadAsInstance = false;
	async post(target, body) {
		const t = getTable('BlobChain');
		const shas = [];
		for (const op of body.ops) {
			const buf = patternBuffer(op.seed, requiredInt(op.size, 'size'));
			shas.push(sha256(buf));
			await t.patch({ id: body.id, blob: createBlob(buf, { type: 'application/octet-stream' }), tag: op.tag });
		}
		return { shas };
	}
}

export class VerifyBlobChain extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const id = requiredId(target);
		const rec = await getTable('BlobChain').get(id);
		if (!rec?.blob) return { present: false, id };
		const bytes = Buffer.from(await rec.blob.bytes());
		return { present: true, id, tag: rec.tag, sha: sha256(bytes), size: bytes.length };
	}
}
