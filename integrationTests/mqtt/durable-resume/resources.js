import { createRequire } from 'node:module';
import { join } from 'node:path';
import { databases, transaction } from 'harper';

let closed = false;

export class Gate extends Resource {
	static loadAsInstance = false;
	post(_target, data) {
		closed = data.closed === true;
		return { closed };
	}
}

export class Gated extends tables.Readings {
	static subscribe(request, context) {
		if (closed) return;
		return super.subscribe(request, context);
	}
}

// Core has no replication transport, so this stands in for a peer's stream: it applies a publish as replication
// does, in that node's own transaction log under the key the node gave it, whenever it arrives here.
const core = process.env.DURABLE_RESUME_CORE;
const nodeIds = core && createRequire(import.meta.url)(join(core, 'resources/nodeIdMapping.js'));
const SEQ = Symbol.for('seq');

export class Peer extends Resource {
	static loadAsInstance = false;
	async post(_target, { node, id, value, key, certifiedThrough }) {
		const { Readings } = tables;
		const nodeId = nodeIds.getIdOfRemoteNode(node, Readings.auditStore);
		if (certifiedThrough !== undefined) {
			// the node's direct route here, certifying everything it wrote below this key
			Readings.dbisDB.putSync([SEQ, nodeId], {
				seqId: 1,
				nodes: [
					{
						id: nodeId,
						closedFloor: certifiedThrough,
						originGeneration: `${node}-generation`,
						fullCoverage: true,
						certifiedFrom: 0,
					},
				],
			});
			return { nodeId };
		}
		const context = { source: {}, sourceApply: true, timestamp: key };
		await transaction(context, async () => {
			const resource = await Readings.getResource(id, context);
			resource._writePublish(id, { id, value }, { isNotification: true, nodeId, version: key });
		});
		return { nodeId };
	}
}

/** Rewrites a saved session as another node would have saved it: its positions are of that node's generation. */
export class MovedSession extends Resource {
	static loadAsInstance = false;
	async post(_target, { clientId }) {
		const Session = databases.system.hdb_durable_session;
		const record = await Session.get(clientId);
		const shared = record.cursors.data;
		const subscriptions = record.subscriptions.map((entry) => {
			const logs = new Map(shared.logs.map(([origin, key]) => [origin, [origin, key, key]]));
			for (const held of entry.cursors) logs.set(held[0], held);
			return {
				...entry,
				databaseGeneration: 'another-generation',
				cursors: { generation: 'another-generation', logs: [...logs.values()] },
			};
		});
		await Session.put({ id: clientId, subscriptions });
		return { moved: subscriptions.length };
	}
}
