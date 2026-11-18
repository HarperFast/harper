// Core supplies admission and sharding but not the Pro replication transport. This fixture delivers the
// owner's actual write identity and indexed projection, then fetches the body over HTTP on a stub read.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Resource, databases, server, transaction } from 'harper';

const nativeRequire = createRequire(import.meta.url);
const { getIdOfRemoteNode } = nativeRequire(join(process.env.REPLICA_FIXTURE_CORE, 'resources/nodeIdMapping.js'));
const { fullWriteHeadKey, REPLICA, INVALIDATED } = nativeRequire(
	join(process.env.REPLICA_FIXTURE_CORE, 'resources/Table.js')
);
const { Reclaimable, Sliding } = databases.replicareclamation;
const ownerURL = process.env.REPLICA_FIXTURE_OWNER;
const owner = ownerURL ? new URL(ownerURL).hostname : server.hostname;
server.shards = new Map([
	[0, [owner]],
	[1, ownerURL ? [server.hostname] : []],
]);

async function ownerEntry(table, id) {
	const query = new URLSearchParams({ table: table.tableName, id, answer: 'true' });
	const response = await fetch(ownerURL + '/ReplicaFixture/?' + query, {
		headers: { authorization: process.env.REPLICA_FIXTURE_AUTH },
	});
	if (!response.ok) throw new Error(`Owner read failed with HTTP ${response.status}`);
	return response.json();
}

const sourceLoads = new Map();
if (ownerURL) {
	for (const table of [Reclaimable, Sliding]) {
		table.sourcedFrom(
			class extends Resource {
				static async load(stub) {
					const key = table.tableName + '/' + stub.key;
					sourceLoads.set(key, (sourceLoads.get(key) ?? 0) + 1);
					const entry = await ownerEntry(table, stub.key);
					if (entry.value && !(entry.expiresAt <= Date.now())) {
						await table._storeReplica(stub, entry);
						return entry;
					}
				}
			},
			{ intermediateSource: true }
		);
	}
}

export class ReplicaFixture extends Resource {
	static loadAsInstance = false;
	async post(_target, { ids, table: name, reader }) {
		if (reader && !ownerURL) {
			server.shards.set(1, [reader]);
			return { reader };
		}
		const table = name === 'Sliding' ? Sliding : Reclaimable;
		for (const id of ids) {
			const answer = await ownerEntry(table, id);
			const context = { source: {}, sourceApply: true, timestamp: answer.version };
			await transaction(context, async () => {
				const row = await table.getResource(id, context, { ensureLoaded: false });
				row._writeInvalidate(
					id,
					{
						name: answer.value.name,
						...(answer.value.validUntil == null ? {} : { validUntil: answer.value.validUntil }),
					},
					{
						version: answer.version,
						nodeId: getIdOfRemoteNode(owner, table.auditStore),
						isCopyApply: true,
					}
				);
			});
		}
		return { stubs: ids.length };
	}
	async get(query) {
		const field = (name) => (query?.get ? query.get(name) : query?.[name]);
		const table = field('table') === 'Sliding' ? Sliding : Reclaimable;
		const id = field('id');
		if (field('keys')) {
			const ids = [];
			const local = field('local') === 'true';
			for (let i = 0; ids.length < 5; i++) {
				const key = field('keys') + '-' + i;
				if (table.getRecordResidency({ key }).includes(server.hostname) === local) ids.push(key);
			}
			return ids;
		}
		const entry = table.primaryStore.getEntry(id, { uncachedRead: true });
		if (field('answer'))
			return entry
				? {
						key: id,
						value: entry.value,
						version: entry.version,
						expiresAt: entry.expiresAt,
						fullWriteHead: fullWriteHeadKey(entry.metadataFlags, entry),
						originNode: server.hostname,
					}
				: {};
		if (field('header'))
			return {
				sourceLoads: sourceLoads.get(table.tableName + '/' + id) ?? 0,
				deadline: entry?.replicaDeadline,
				expiresAt: entry?.expiresAt,
				replica: Boolean(entry?.metadataFlags & REPLICA),
				stub: Boolean(entry?.metadataFlags & INVALIDATED),
				body: entry?.value?.body ?? null,
			};
		return { name: entry?.value?.name ?? null, body: entry?.value?.body ?? null };
	}
}
