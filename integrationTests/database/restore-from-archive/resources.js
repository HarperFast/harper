import { createHash, createHmac } from 'node:crypto';

function patternBuffer(seed, size) {
	const out = Buffer.allocUnsafe(size);
	for (let offset = 0, counter = 0; offset < size; counter++) {
		const block = createHmac('sha256', seed).update(String(counter)).digest();
		offset += block.copy(out, offset, 0, Math.min(block.length, size - offset));
	}
	return out;
}

// Looked up per request rather than declared, so the component never holds the database open and an
// online restore can close it.
export class ArchiveRestoreBlobs extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const Items = databases[body?.database]?.Items;
		if (!Items) return { missing: true };
		switch (body.action) {
			case 'put': {
				const data = body.seed ? createBlob(patternBuffer(body.seed, body.size ?? 64 * 1024)) : undefined;
				await Items.put({ id: body.id, label: body.label, data });
				return { ok: true };
			}
			case 'delete':
				await Items.delete(body.id);
				return { ok: true };
			case 'snapshot': {
				const records = {};
				for await (const record of Items.search([])) {
					const bytes = record.data ? Buffer.from(await record.data.arrayBuffer()) : undefined;
					records[record.id] = {
						label: record.label,
						size: bytes?.length,
						sha256: bytes && createHash('sha256').update(bytes).digest('hex'),
					};
				}
				return records;
			}
			default:
				throw new Error(`unknown action ${body.action}`);
		}
	}
}
