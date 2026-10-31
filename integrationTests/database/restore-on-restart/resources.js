import { createHash, createHmac } from 'node:crypto';

const { RestoreRestartItem } = databases.restore_on_restart;

function patternBuffer(seed, size) {
	const out = Buffer.allocUnsafe(size);
	for (let offset = 0, counter = 0; offset < size; counter++) {
		const block = createHmac('sha256', seed).update(String(counter)).digest();
		offset += block.copy(out, offset, 0, Math.min(block.length, size - offset));
	}
	return out;
}

export class RestoreRestartBlobs extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		switch (body?.action) {
			case 'put': {
				const data = body.seed ? createBlob(patternBuffer(body.seed, body.size ?? 64 * 1024)) : undefined;
				await RestoreRestartItem.put({ id: body.id, label: body.label, data });
				return { ok: true };
			}
			case 'delete':
				await RestoreRestartItem.delete(body.id);
				return { ok: true };
			case 'snapshot': {
				const records = {};
				for await (const record of RestoreRestartItem.search([])) {
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
				throw new Error(`unknown action ${body?.action}`);
		}
	}
}
