import { getDatabases, table } from '../../resources/databases';
import { NodeReplicationConnection } from './replicationConnection';

let hdb_node_table;
function getHDBNodeTable() {
	return (
		hdb_node_table ||
		(hdb_node_table = table({
			table: 'hdb_node_table',
			database: 'system',
			audit: true,
			attributes: [
				{
					name: 'url',
					isPrimaryKey: true,
				},
				{
					name: 'routes',
				},
			],
		}))
	);
}
let new_node_listeners = [];
let all_nodes: any[];
export function forEachNode(onNewNode: (node: { name: string; url: string }) => { end: () => void }) {
	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (let event of events) {
				if (event.type === 'put') {
					onNewNode(event.value);
				}
			}
		});
}
function initialize() {
	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (let event of events) {
				onNodesChange();
			}
		});
	onNodesChange();
}
let known_instances = [];
let enqueued_connect;

function onNodesChange() {
	let new_known_instances = [];
	all_nodes = [];
	for (let node of getHDBNodeTable().search({})) {
		all_nodes.push(node);
		if (node.url || node.host) {
			new_known_instances.push(node.url || 'wss://' + node.host + ':' + (node.port || 9925));
		}
	}
	if (new_known_instances.toString() !== known_instances.toString()) {
		known_instances = new_known_instances;
		clearTimeout(enqueued_connect);
		enqueued_connect = setTimeout(() => {
			for (const url of new_known_instances) {
				if (known_instances.includes(url)) continue;
				for (let listener of new_node_listeners) {
					listener({ name: new URL(url).hostname, url });
				}
				try {
					const connection = new NodeReplicationConnection(url, subscription, db_name);
					connection.connect();
				} catch (error) {
					console.error(error);
				}
			}
			known_instances = new_known_instances;
		}, 1);
	}
}

export function ensureNode(url: string, routes = []) {
	const table = getHDBNodeTable();
	if (!table.primaryStore.get(url)) {
		table.put({ url, routes });
	}
}
