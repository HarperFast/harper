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
const coreModule = (path) => core && createRequire(import.meta.url)(join(core, path));
const nodeIds = coreModule('resources/nodeIdMapping.js');
const nodeName = coreModule('server/nodeName.js');
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

/**
 * Rewrites a saved session as another node would have saved it, that node vouching for this node's own log, and
 * without its receipts, as when it did not end cleanly there.
 */
export class MovedSession extends Resource {
	static loadAsInstance = false;
	async post(_target, { clientId }) {
		const Session = databases.system.hdb_durable_session;
		const record = await Session.get(clientId);
		const generation = tables.Readings.auditStore.databaseGeneration.id;
		const shared = record.cursors.data;
		const subscriptions = record.subscriptions.map((entry) => {
			const logs = new Map(shared.logs.map(([origin, key, vouched]) => [origin, [origin, key, key, vouched]]));
			for (const held of entry.cursors) logs.set(held[0], held);
			logs.get(nodeName.getThisNodeName())[3] = generation;
			const { received: _received, receivedRuns: _runs, receivedThrough: _through, ...kept } = entry;
			return {
				...kept,
				databaseGeneration: 'another-generation',
				cursors: {
					generation: 'another-generation',
					logs: [...logs.values()].map((log) => log.filter((part) => part !== undefined)),
				},
			};
		});
		await Session.put({ id: clientId, subscriptions });
		return { vouched: subscriptions[0].cursors.logs.filter((log) => log[3] !== undefined).map((log) => log[0]) };
	}
}
