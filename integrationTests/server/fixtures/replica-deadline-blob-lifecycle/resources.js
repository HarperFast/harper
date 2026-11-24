import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Resource, databases, server, transaction } from 'harper';

const nativeRequire = createRequire(import.meta.url);
const coreDir = process.env.REPLICA_FIXTURE_CORE;
if (!coreDir) throw new Error('REPLICA_FIXTURE_CORE env var is required');

const { getIdOfRemoteNode } = nativeRequire(join(coreDir, 'resources/nodeIdMapping.js'));
const { fullWriteHeadKey, REPLICA, INVALIDATED, FULL_WRITE_HEAD } = nativeRequire(join(coreDir, 'resources/Table.js'));
const { HAS_REPLICA_DEADLINE = 0x200000, HAS_EXPIRATION } = nativeRequire(join(coreDir, 'resources/RecordEncoder.js'));
const { HAS_BLOBS } = nativeRequire(join(coreDir, 'resources/auditStore.js'));
const { getFileId } = nativeRequire(join(coreDir, 'resources/blob.js'));

const SCHEMA_TABLE_MAP = {
	MediaNoAudit: 'repblob_noaudit',
	MediaAudit: 'repblob_audit',
	DualTtl: 'repblob_dual',
	BackupTarget: 'repblob_backup',
	LmdbReplicaOpt: 'repblob_lmdb_ctrl',
};

const LEGACY_RESIDENCY_ID = 123456;

function resolveTable(tableName, dbName) {
	const resolvedDb = dbName ?? SCHEMA_TABLE_MAP[tableName];
	if (!resolvedDb) throw new Error(`Unknown schema table: ${tableName}`);
	const db = databases[resolvedDb];
	if (!db) throw new Error(`Unknown database: ${resolvedDb}`);
	const tbl = db[tableName];
	if (!tbl) throw new Error(`Unknown table ${resolvedDb}.${tableName}`);
	return tbl;
}

const ownerURL = process.env.REPLICA_FIXTURE_OWNER;
const owner = ownerURL ? new URL(ownerURL).hostname : server.hostname;
server.shards = new Map([
	[0, [owner]],
	[1, ownerURL ? [server.hostname] : []],
]);

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

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

function makeBlob(buf) {
	return globalThis.createBlob(buf, { type: 'application/octet-stream' });
}

async function blobBytes(blob) {
	if (!blob) return null;
	if (typeof blob.bytes === 'function') return Buffer.from(await blob.bytes());
	if (typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
	throw new Error(`Unsupported blob object: ${Object.prototype.toString.call(blob)}`);
}

async function ownerEntry(table, id, reason) {
	const query = new URLSearchParams({ action: 'answer', table: table.tableName, id, reason });
	const response = await fetch(ownerURL + '/ReplicaBlobFixture/?' + query, {
		headers: { authorization: process.env.REPLICA_FIXTURE_AUTH },
	});
	if (!response.ok) throw new Error(`Owner read failed with HTTP ${response.status}: ${await response.text()}`);
	const data = await response.json();
	if (data.value && data.attachmentBase64) {
		data.value.attachment = makeBlob(Buffer.from(data.attachmentBase64, 'base64'));
		delete data.attachmentBase64;
	}
	return data;
}

const ownerLoadCounts = new Map();
if (ownerURL) {
	for (const [tableName, dbName] of Object.entries(SCHEMA_TABLE_MAP)) {
		const table = databases[dbName]?.[tableName];
		if (!table) continue;
		if (!table.audit) {
			table.dbisDB?.putSync([Symbol.for('residency_by_id'), LEGACY_RESIDENCY_ID], [owner]);
		}
		table.sourcedFrom(
			class extends Resource {
				static async load(stub) {
					const entry = await ownerEntry(table, stub.key, 'load');
					if (entry.value && !(entry.expiresAt <= Date.now())) {
						if (!table.audit) {
							entry.originNode = server.hostname;
							entry.version = stub.version;
							entry.fullWriteHead = stub.version;
						}
						await table._storeReplica(stub, entry);
						return entry;
					}
				}
			},
			{ intermediateSource: true }
		);
	}
}

function requireParam(query, name) {
	const val = query?.get ? query.get(name) : undefined;
	if (val == null || val === '') throw new Error(`Missing required query parameter: ${name}`);
	return val;
}

function optionalParam(query, name) {
	const val = query?.get ? query.get(name) : undefined;
	return val == null || val === '' ? undefined : val;
}

function scanTagIndex(table, filterTag = undefined) {
	const index = table.indices?.tag;
	if (!index) return [];
	const pairs = [];
	if (typeof index.getValues === 'function') {
		const keys = filterTag !== undefined ? [filterTag] : [...index.getKeys({ start: true, snapshot: false })];
		for (const k of keys) {
			for (const v of index.getValues(k)) pairs.push([k, v]);
		}
	} else {
		for (const entry of index.getRange({ start: true, snapshot: false })) {
			const k = Array.isArray(entry.key) ? entry.key[0] : entry.key;
			const id = Array.isArray(entry.key) ? entry.key[1] : entry.value;
			if (filterTag === undefined || k === filterTag) pairs.push([k, id]);
		}
	}
	return pairs;
}

export class ReplicaBlobFixture extends Resource {
	static loadAsInstance = false;

	async post(_target, payload) {
		if (!payload || typeof payload !== 'object' || !payload.action) {
			throw new Error('Missing required body field: action');
		}
		const { action } = payload;

		if (action === 'setReader') {
			if (!payload.reader) throw new Error('setReader requires reader');
			if (!ownerURL) server.shards.set(1, [payload.reader]);
			return { reader: payload.reader };
		}

		const table = resolveTable(payload.table, payload.db);

		if (action === 'putOwner') {
			const { id, tag, note, blobSeed, blobSize } = payload;
			if (!id) throw new Error('putOwner requires id');
			const record = { id };
			if (tag !== undefined) record.tag = tag;
			if (note !== undefined) record.note = note;
			let expectedSha256 = null;
			if (blobSize !== undefined) {
				if (!blobSeed) throw new Error('putOwner with blobSize requires blobSeed');
				const buf = patternBuffer(blobSeed, blobSize);
				expectedSha256 = sha256Hex(buf);
				record.attachment = makeBlob(buf);
			}
			await table.put(record);
			const stored = table.primaryStore.getEntry(id, { uncachedRead: true });
			const storedBlob = stored?.value?.attachment;
			return {
				id,
				version: stored?.version ?? null,
				expiresAt: stored?.expiresAt ?? null,
				blobSha256: expectedSha256,
				blobFileId: storedBlob ? (getFileId(storedBlob) ?? null) : null,
				blobSize: storedBlob?.size ?? null,
			};
		}

		if (action === 'seedStubs') {
			const { ids } = payload;
			if (!Array.isArray(ids) || ids.length === 0) throw new Error('seedStubs requires non-empty ids array');
			for (const id of ids) {
				const answer = await ownerEntry(table, id, 'seed');
				if (!answer.value) throw new Error(`Owner had no entry for ${table.tableName}/${id}`);
				const stubFields = {};
				if (answer.value.tag !== undefined) stubFields.tag = answer.value.tag;
				if (table.audit) {
					const context = { source: {}, sourceApply: true, timestamp: answer.version };
					await transaction(context, async () => {
						const row = await table.getResource(id, context, { ensureLoaded: false });
						row._writeInvalidate(id, stubFields, {
							version: answer.version,
							nodeId: getIdOfRemoteNode(owner, table.auditStore),
							isCopyApply: true,
						});
					});
				} else {
					const context = {};
					await transaction(context, async () => {
						const row = await table.getResource(id, context, { ensureLoaded: false });
						row._writeInvalidate(id, stubFields, {
							residencyId: LEGACY_RESIDENCY_ID,
						});
					});
				}
			}
			return { stubs: ids.length };
		}

		if (action === 'readRecord') {
			const { id, verifyBlob } = payload;
			if (!id) throw new Error('readRecord requires id');
			const record = await table.get(id);
			if (!record) return { found: false };
			let blobSha256 = null;
			let blobLength = null;
			let blobError = null;
			if (verifyBlob && record.attachment) {
				try {
					const bytes = await blobBytes(record.attachment);
					blobSha256 = sha256Hex(bytes);
					blobLength = bytes.length;
				} catch (err) {
					blobError = err?.message ?? String(err);
				}
			}
			return {
				found: true,
				id: record.id,
				tag: record.tag ?? null,
				note: record.note ?? null,
				hasAttachment: record.attachment !== undefined && record.attachment !== null,
				blobSha256,
				blobLength,
				blobError,
			};
		}

		if (action === 'clearTable') {
			await table.clear();
			return { cleared: true };
		}

		if (action === 'flushTable') {
			await table.primaryStore.flush();
			return { flushed: true };
		}

		throw new Error(`Unknown POST action: ${action}`);
	}

	async get(query) {
		const action = requireParam(query, 'action');

		if (action === 'ping') {
			return { ok: true, hostname: server.hostname };
		}

		const dbName = optionalParam(query, 'db');
		const tableName = requireParam(query, 'table');
		const table = resolveTable(tableName, dbName);

		if (action === 'keys') {
			const prefix = requireParam(query, 'prefix');
			const localRaw = requireParam(query, 'local');
			if (localRaw !== 'true' && localRaw !== 'false') {
				throw new Error(`Invalid local param (expected 'true' or 'false'): ${localRaw}`);
			}
			const local = localRaw === 'true';
			const countRaw = requireParam(query, 'count');
			const count = Number.parseInt(countRaw, 10);
			if (!Number.isInteger(count) || count <= 0) {
				throw new Error(`Invalid count param: ${countRaw}`);
			}
			const ids = [];
			if (!table.residency) {
				for (let i = 0; i < count; i++) ids.push(`${prefix}-${i}`);
				return ids;
			}
			for (let i = 0; ids.length < count; i++) {
				const key = `${prefix}-${i}`;
				if (table.getRecordResidency({ key }).includes(server.hostname) === local) ids.push(key);
			}
			return ids;
		}

		if (action === 'ownerLoads') {
			const id = requireParam(query, 'id');
			return { id, count: ownerLoadCounts.get(table.tableName + '/' + id) ?? 0 };
		}

		if (action === 'answer') {
			const id = requireParam(query, 'id');
			const reason = requireParam(query, 'reason');
			if (reason === 'load') {
				const k = table.tableName + '/' + id;
				ownerLoadCounts.set(k, (ownerLoadCounts.get(k) ?? 0) + 1);
			}
			const entry = table.primaryStore.getEntry(id, { uncachedRead: true });
			if (!entry) return {};
			const valueCopy = entry.value && typeof entry.value === 'object' ? { ...entry.value } : entry.value;
			let attachmentBase64 = null;
			if (valueCopy?.attachment) {
				const bytes = await blobBytes(valueCopy.attachment);
				attachmentBase64 = bytes.toString('base64');
				delete valueCopy.attachment;
			}
			return {
				key: id,
				value: valueCopy,
				attachmentBase64,
				version: entry.version,
				expiresAt: entry.expiresAt,
				fullWriteHead: fullWriteHeadKey(entry.metadataFlags, entry),
				originNode: server.hostname,
			};
		}

		if (action === 'inspect') {
			const id = requireParam(query, 'id');
			const verifyBlob = optionalParam(query, 'verifyBlob') === 'true';
			const entry = table.primaryStore.getEntry(id, { uncachedRead: true });
			const tagIndexIds = scanTagIndex(table)
				.filter(([, indexedId]) => indexedId === id)
				.map(([tagVal]) => tagVal);
			if (!entry) {
				return {
					exists: false,
					id,
					indexedTags: tagIndexIds,
				};
			}
			const flags = entry.metadataFlags ?? 0;
			const val = entry.value;
			const blob = val?.attachment;
			let blobFileId = null;
			let blobSize = null;
			let blobSha256 = null;
			let blobError = null;
			if (blob) {
				blobFileId = getFileId(blob) ?? null;
				blobSize = blob.size ?? null;
				if (verifyBlob) {
					try {
						const bytes = await blobBytes(blob);
						blobSha256 = sha256Hex(bytes);
					} catch (err) {
						blobError = err?.message ?? String(err);
					}
				}
			}
			return {
				exists: true,
				id,
				version: entry.version ?? null,
				expiresAt: entry.expiresAt ?? null,
				replicaDeadline: entry.replicaDeadline ?? null,
				flags: {
					replica: Boolean(flags & REPLICA),
					invalidated: Boolean(flags & INVALIDATED),
					fullWriteHead: Boolean(flags & FULL_WRITE_HEAD),
					hasReplicaDeadline: Boolean(flags & HAS_REPLICA_DEADLINE),
					hasBlobs: Boolean(flags & HAS_BLOBS),
					hasExpiration: Boolean(flags & HAS_EXPIRATION),
				},
				blobFileId,
				blobSize,
				blobSha256,
				blobError,
				indexedTags: tagIndexIds,
			};
		}

		if (action === 'searchTag') {
			const tag = requireParam(query, 'tag');
			const indexIds = scanTagIndex(table, tag).map(([, indexedId]) => indexedId);
			return { tag, indexIds };
		}

		throw new Error(`Unknown GET action: ${action}`);
	}
}
