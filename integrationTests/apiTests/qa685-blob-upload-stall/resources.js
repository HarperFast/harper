// QA-685 — control-write target. A steady stream of these hits an UNRELATED table
// (ControlWrite) while one or more raw-socket blob uploads sit stalled mid-body on
// MediaAsset. Reports `threadId` (node:worker_threads) so the test can attribute each
// write to the worker that served it.

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
