// QA-597 — EAV substrate x Blob-valued attribute x type-drift on the same value slot.
//
// Deterministic payload generation happens server-side (from a seed) so large blob
// bodies never have to cross the wire on write — only small JSON in/out. The client
// verifies round-trip fidelity independently via REST GET (both the full record and
// the `.value` dot-notation sub-attribute route), computing sha256 itself.

import { createHash, createHmac } from 'node:crypto';

const { Attribute } = tables;

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

// POST /AttrOps/  { action, ... }
export class AttrOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		try {
			switch (action) {
				// Write the EAV value slot as either a scalar or a blob, driven purely by
				// `kind` — the same `value` property is assigned either way, so any type
				// validation or blob-lifecycle handling is whatever the encoder does for an
				// `Any`-typed attribute, not something this resource special-cases.
				case 'write': {
					const id = String(body.id);
					const kind = String(body.kind); // 'blob' | 'scalar-string' | 'scalar-number'
					let value;
					let sha256;
					let byteLength;
					if (kind === 'blob') {
						const size = Number(body.size) || 65536;
						const data = patternBuffer(String(body.seed), size);
						sha256 = sha256hex(data);
						byteLength = data.length;
						value = createBlob(data, { type: 'application/octet-stream' });
					} else if (kind === 'scalar-number') {
						value = Number(body.seed) || 0;
					} else {
						// scalar-string
						value = String(body.seed);
					}
					await Attribute.put({
						id,
						entityId: body.entityId ?? id,
						name: body.name ?? 'attr',
						value,
						valueKind: kind,
						gen: Number(body.gen) || 0,
					});
					return { ok: true, id, kind, sha256, byteLength };
				}

				case 'delete': {
					const id = String(body.id);
					await Attribute.delete(id);
					return { ok: true, id };
				}

				// Internal (non-REST) read path: characterizes the ACTUAL runtime type of
				// `value` as stored, independent of how the REST serializer chooses to
				// present it. This is the cross-check for "does a scalar read after a blob
				// ever return stale/garbage bytes" from inside the resource layer.
				case 'verifyServer': {
					const id = String(body.id);
					const rec = await Attribute.get(id);
					if (!rec) return { ok: true, present: false };
					const v = rec.value;
					// Duck-type rather than `instanceof Blob` — avoids any surprise if the
					// resource sandbox's Blob global isn't referentially identical to the one
					// blob.ts's FileBackedBlob prototype-chains onto.
					const looksLikeBlob = v && typeof v === 'object' && typeof v.bytes === 'function';
					if (looksLikeBlob) {
						let sha256 = null;
						let byteLength = null;
						let readError = null;
						try {
							const bytes = Buffer.from(await v.bytes());
							byteLength = bytes.length;
							sha256 = sha256hex(bytes);
						} catch (e) {
							readError = String((e && e.message) || e);
						}
						return {
							ok: true,
							present: true,
							kind: 'blob',
							storedValueKind: rec.valueKind,
							sha256,
							byteLength,
							readError,
						};
					}
					return {
						ok: true,
						present: true,
						kind: typeof v,
						storedValueKind: rec.valueKind,
						scalarValue: v,
					};
				}

				default: {
					const ctx = this.getContext();
					if (ctx && ctx.response) ctx.response.status = 400;
					return { ok: false, reason: 'unknown-action', action };
				}
			}
		} catch (e) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 500;
			return { ok: false, error: String((e && e.message) || e) };
		}
	}
}
