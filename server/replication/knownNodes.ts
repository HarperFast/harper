import { table } from '../../resources/databases';
import { forEachReplicatedDatabase, getThisNodeName } from './replicator';
import { replicationConfirmation } from '../../resources/DatabaseTransaction';
import { isMainThread } from 'worker_threads';
let hdb_node_table;

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
					attribute: 'replicates',
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
export function subscribeToNodeUpdates(listener) {
	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (let event of events) {
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
			getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates !== false) ||
		node.subscriptions?.some((sub) => (sub.database || sub.schema) === database_name && sub.subscribe)
	);
}

const replication_confirmation_float64s = new Map<string, Map<string, Float64Array>>();
/** Ensure that the shared user buffers are instantiated so we can communicate through them
 */
export let commits_awaiting_replication: Map<string, []>;

replicationConfirmation((database_name, txnTime, confirmationCount) => {
	if (!commits_awaiting_replication) {
		commits_awaiting_replication = new Map();
		startSubscriptionToReplications();
	}
	let awaiting = commits_awaiting_replication.get(database_name);
	if (!awaiting) commits_awaiting_replication.set(database_name, (awaiting = []));
	return new Promise((resolve) => {
		let count = 0;
		awaiting.push({
			txnTime,
			onConfirm: () => {
				if (++count === confirmationCount) resolve();
			},
		});
	});
});
function startSubscriptionToReplications() {
	subscribeToNodeUpdates((node_record) => {
		forEachReplicatedDatabase({}, (database, database_name) => {
			let node_name = node_record.name;
			let confirmations_for_node = replication_confirmation_float64s.get(node_name);
			if (!confirmations_for_node) {
				replication_confirmation_float64s.set(node_name, (confirmations_for_node = new Map()));
			}
			if (confirmations_for_node.has(database_name)) return;
			let audit_store;
			for (let table_name in database) {
				const table = database[table_name];
				audit_store = table.auditStore;
				if (audit_store) break;
			}
			if (audit_store) {
				let replicated_time = new Float64Array(
					audit_store.getUserSharedBuffer(['replicated', database_name, node_name], new ArrayBuffer(8), {
						callback: () => {
							let updated_time = replicated_time[0];
							let last_time = replicated_time.lastTime;
							for (let { txnTime, onConfirm } of commits_awaiting_replication.get(database_name) || []) {
								if (txnTime > last_time && txnTime <= updated_time) {
									onConfirm();
								}
							}
							replicated_time.lastTime = updated_time;
						},
					})
				);
				replicated_time.lastTime = 0;
				confirmations_for_node.set(database_name, replicated_time);
			}
		});
	});
}

export function* iterateRoutes(options) {
	for (const route of options.routes || []) {
		let url = typeof route === 'string' ? route : route.url;
		if (!url) {
			if (route.host) url = 'wss://' + route.host + ':' + (route.port || 9925);
			else if (route.hostname) url = 'wss://' + route.hostname + ':' + (route.port || 9925);
			else {
				if (isMainThread) console.error('Invalid route, must specify a url or host (with port)');
				continue;
			}
		}
		yield {
			url,
			subscription: route.subscriptions,
			routes: route.routes,
		};
	}
}
