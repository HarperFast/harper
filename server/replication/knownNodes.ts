/**
 * This module is responsible for managing the list of known nodes in the network. This also tracks replication confirmation
 * when we want to ensure that a transaction has been replicated to multiple nodes before we confirm it.
 */
import { table } from '../../resources/databases';
import { forEachReplicatedDatabase, getThisNodeName } from './replicator';
import { replicationConfirmation } from '../../resources/DatabaseTransaction';
import { isMainThread } from 'worker_threads';
import { ClientError } from '../../utility/errors/hdbError';
import env from '../../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../../utility/hdbTerms';
import * as logger from '../../utility/logging/logger';

let hdb_node_table;
server.nodes = [];

export function getHDBNodeTable() {
	return (
		hdb_node_table ||
		(hdb_node_table = table({
			table: 'hdb_nodes',
			database: 'system',
			attributes: [
				{
					name: 'name',
					isPrimaryKey: true,
				},
				{
					attribute: 'subscriptions',
				},
				{
					attribute: 'system_info',
				},
				{
					attribute: 'url',
				},
				{
					attribute: 'routes',
				},
				{
					attribute: 'ca',
				},
				{
					attribute: 'ca_info',
				},
				{
					attribute: 'replicates',
				},
				{
					attribute: 'revoked_certificates',
				},
				{
					attribute: '__createdtime__',
				},
				{
					attribute: '__updatedtime__',
				},
			],
		}))
	);
}
export function getReplicationSharedStatus(
	audit_store: any,
	database_name: string,
	node_name: string,
	callback?: () => void
) {
	return new Float64Array(
		audit_store.getUserSharedBuffer(
			['replicated', database_name, node_name],
			new ArrayBuffer(48),
			callback && { callback }
		)
	);
}
export function subscribeToNodeUpdates(listener: (node: any, id: string) => void) {
	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (const event of events) {
				// remove any nodes that have been updated or deleted
				const node_name = event?.value?.name;
				logger.debug?.('adding node', node_name, 'on  node', getThisNodeName(), ' on process', process.pid);
				server.nodes = server.nodes.filter((node) => node.name !== node_name);
				if (event.type === 'put' && node_name !== getThisNodeName()) {
					// add any new nodes
					if (event.value) server.nodes.push(event.value);
					else {
						console.error('Invalid node update event', event);
					}
				}
				const shards = new Map();
				for await (const node of getHDBNodeTable().search({})) {
					if (node.shard != undefined) {
						let nodesForShard = shards.get(node.shard);
						if (!nodesForShard) {
							shards.set(node.shard, (nodesForShard = []));
						}
						nodesForShard.push(node);
					}
				}
				server.shards = shards;
				if (event.type === 'put' || event.type === 'delete') {
					listener(event.value, event.id);
				}
			}
		});
}

export function shouldReplicateToNode(node, database_name) {
	return (
		((node.replicates === true || node.replicates?.sends) &&
			databases[database_name] &&
			getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates) ||
		node.subscriptions?.some((sub) => (sub.database || sub.schema) === database_name && sub.subscribe)
	);
}

const replication_confirmation_float64s = new Map<string, Map<string, Float64Array>>();
/** Ensure that the shared user buffers are instantiated so we can communicate through them
 */

type AwaitingReplication = {
	txnTime: number;
	onConfirm: () => void;
};
export let commits_awaiting_replication: Map<string, AwaitingReplication[]>;

replicationConfirmation((database_name, txnTime, confirmation_count): Promise<void> => {
	if (confirmation_count > server.nodes.length) {
		throw new ClientError(
			`Cannot confirm replication to more nodes (${confirmation_count}) than are in the network (${server.nodes.length})`
		);
	}
	if (!commits_awaiting_replication) {
		commits_awaiting_replication = new Map();
		startSubscriptionToReplications();
	}
	let awaiting: AwaitingReplication[] = commits_awaiting_replication.get(database_name);
	if (!awaiting) {
		awaiting = [];
		commits_awaiting_replication.set(database_name, awaiting);
	}
	return new Promise((resolve) => {
		let count = 0;
		awaiting.push({
			txnTime,
			onConfirm: () => {
				if (++count === confirmation_count) resolve();
			},
		});
	});
});
function startSubscriptionToReplications() {
	subscribeToNodeUpdates((node_record) => {
		forEachReplicatedDatabase({}, (database, database_name) => {
			const node_name = node_record.name;
			let confirmations_for_node = replication_confirmation_float64s.get(node_name);
			if (!confirmations_for_node) {
				replication_confirmation_float64s.set(node_name, (confirmations_for_node = new Map()));
			}
			if (confirmations_for_node.has(database_name)) return;
			let audit_store;
			for (const table_name in database) {
				const table = database[table_name];
				audit_store = table.auditStore;
				if (audit_store) break;
			}
			if (audit_store) {
				const replicated_time = getReplicationSharedStatus(audit_store, database_name, node_name, () => {
					const updated_time = replicated_time[0];
					const last_time = replicated_time.lastTime;
					for (const { txnTime, onConfirm } of commits_awaiting_replication.get(database_name) || []) {
						if (txnTime > last_time && txnTime <= updated_time) {
							onConfirm();
						}
					}
					replicated_time.lastTime = updated_time;
				});
				replicated_time.lastTime = 0;
				confirmations_for_node.set(database_name, replicated_time);
			}
		});
	});
}
type Route = {
	url?: string;
	subscriptions?: { database: string; schema: string; subscribe: boolean }[];
	hostname?: string;
	host?: string;
	port?: any;
	routes?: any[];
};

export function* iterateRoutes(options: { routes: (Route | any)[] }) {
	for (const route of options.routes || []) {
		let url = route.url;
		let host;
		if (typeof route === 'string') {
			// a plain route string can be a url or hostname (or host)
			if (route.includes('://')) url = route;
			else host = route;
		} else host = route.hostname ?? route.host;
		if (host && !url) {
			// construct a url from the host and port
			const secure_port =
				env.get(CONFIG_PARAMS.REPLICATION_SECUREPORT) ??
				(!env.get(CONFIG_PARAMS.REPLICATION_PORT) && env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT));
			let port: any;
			// if the host includes a port, use that port
			if ((port = host.match(/:(\d+)$/)?.[1])) host = host.slice(0, -port[0].length - 1);
			else if (route.port)
				port = route.port; // could be in the routes config
			// otherwise use the default port for the service
			else
				port =
					secure_port || env.get(CONFIG_PARAMS.REPLICATION_PORT) || env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
			const last_colon = port?.lastIndexOf?.(':');
			if (last_colon > 0) port = +port.slice(last_colon + 1).replace(/[\[\]]/g, '');

			url = (secure_port ? 'wss://' : 'ws://') + host + ':' + port; // now construct the full url
		}
		if (!url) {
			if (isMainThread) console.error('Invalid route, must specify a url or host (with port)');
			continue;
		}

		yield {
			replicates: !route.subscriptions, // if there is not a list of subscriptions, then this node is authorized to fully replicate
			url,
			subscription: route.subscriptions,
			routes: route.routes,
			start_time: route.startTime,
			revoked_certificates: route.revokedCertificates,
		};
	}
}
