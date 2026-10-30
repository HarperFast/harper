// harper#3594 sealed-table fixture: tracked-instance edits held across a code-first table re-declaration, two workers.
// Every worker declares the OLD shape (with legacyCode) at module load.
import { Resource, defineTable, types, transaction } from 'harper';
import { threadId } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

const { id, string, int, date } = types;

const oldShape = {
	id: id.primaryKey,
	label: string,
	legacyCode: int.nullable,
	createdAt: date.createdTime,
	updatedAt: date.updatedTime,
};
const newShape = {
	id: id.primaryKey,
	label: string,
	createdAt: date.createdTime,
	updatedAt: date.updatedTime,
};

export const SealedItem = defineTable('SealedItem', oldShape, { sealed: true });
export const OpenItem = defineTable('OpenItem', oldShape, { sealed: false });
const TABLES = { SealedItem, OpenItem };

function need(source, name) {
	const value = typeof source?.get === 'function' ? source.get(name) : source?.[name];
	if (value === undefined || value === null || value === '') throw new Error(`missing required param "${name}"`);
	return value;
}
function pickTable(name) {
	const t = TABLES[name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}
function attrNames(t) {
	return t.attributes.map((a) => a.name);
}
// Requests carry the worker they must run on; a mismatch is a no-op the test retries.
function wrongThread(want) {
	if (want === 'any' || Number(want) === threadId) return null;
	return { wrongThread: true, threadId };
}
function plain(record) {
	return record == null ? null : JSON.parse(JSON.stringify(record));
}

async function waitForGate(gatePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(gatePath)) {
		if (Date.now() > deadline) throw new Error(`gate ${gatePath} not released within ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function editHandle(Table, rowId, fields, patchLabel, beforeAssign) {
	await transaction(async () => {
		const record = patchLabel ? await Table.update(rowId, { label: 'pre' }) : await Table.update(rowId);
		if (beforeAssign) await beforeAssign();
		for (const [name, value] of Object.entries(fields)) record[name] = value;
	});
}

export class Qa extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const op = need(target, 'op');
		const wrong = wrongThread(need(target, 'thread'));
		if (wrong) return wrong;
		if (op === 'whoami') return { threadId };
		if (op === 'schema') {
			return { threadId, SealedItem: attrNames(SealedItem), OpenItem: attrNames(OpenItem) };
		}
		if (op === 'read') {
			const Table = pickTable(need(target, 'table'));
			return { threadId, record: plain(await Table.get(need(target, 'id'))) };
		}
		throw new Error(`unknown get op "${op}"`);
	}

	async post(target, data) {
		const op = need(data, 'op');
		const wrong = wrongThread(need(data, 'thread'));
		if (wrong) return wrong;
		if (op === 'seed') {
			const Table = pickTable(need(data, 'table'));
			await Table.put({ id: need(data, 'id'), label: 'seed', legacyCode: 42 });
			return { threadId };
		}
		if (op === 'hold' || op === 'fresh') {
			const Table = pickTable(need(data, 'table'));
			const rowId = need(data, 'id');
			const fields = need(data, 'fields');
			const patchLabel = data.patchLabel === true;
			let beforeAssign;
			let heldAt;
			if (op === 'hold') {
				const dir = need(data, 'dir');
				const token = need(data, 'token');
				beforeAssign = async () => {
					heldAt = Date.now();
					fs.writeFileSync(path.join(dir, `held-${token}`), String(heldAt));
					await waitForGate(path.join(dir, 'gate'), 60000);
				};
			}
			await editHandle(Table, rowId, fields, patchLabel, beforeAssign);
			return { ok: true, threadId, heldAt, doneAt: Date.now() };
		}
		if (op === 'redeclare') {
			const startedAt = Date.now();
			const S = defineTable('SealedItem', newShape, { sealed: true });
			const O = defineTable('OpenItem', newShape, { sealed: false });
			return { threadId, startedAt, doneAt: Date.now(), SealedItem: attrNames(S), OpenItem: attrNames(O) };
		}
		throw new Error(`unknown post op "${op}"`);
	}
}
