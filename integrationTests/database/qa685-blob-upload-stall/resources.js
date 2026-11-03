import { threadId } from 'node:worker_threads';

const { ControlWrite } = tables;

export class ControlOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const t0 = Date.now();
		const id = String(body.id);
		await ControlWrite.put({ id, seq: Number(body.seq) || 0, writer: Number(body.writer) || 0, ts: Date.now() });
		return { ok: true, threadId, id, writeMs: Date.now() - t0 };
	}
}
