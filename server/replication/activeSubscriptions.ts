import { isMainThread, parentPort, threadId } from "worker_threads";
import { broadcast, onMessageByType } from '../threads/manageThreads';

export const active_subscriptions = new Map<string, Map<string, { threadId: number, listener: Function } >>();
if (isMainThread) {
	onMessageByType('add-subscription', (message) => {
		addNodeSubscription(message.database, message.nodeId, message.threadId);
	});
} else {
	onMessageByType('add-subscription', (message) => {
		addedSubscription(message.database, message.nodeId, message.threadId);
	});
}
export function addNodeSubscription(database: string, node_id: string, listener: Function, thread_id = threadId) {
	const message = {
		type: 'add-subscription',
		database,
		nodeId: node_id,
		threadId: thread_id,
	};
	if (isMainThread) {
		broadcast(message);
	} else {
		parentPort.postMessage(message);
	}
	addedSubscription(database, node_id, listener, thread_id);
}
function addedSubscription(database: string, node_id: string, listener: Function, thread_id: number) {
	let node_id_to_thread_id = active_subscriptions.get(database);
	if (!node_id_to_thread_id) {
		node_id_to_thread_id = new Map();
		active_subscriptions.set(database, node_id_to_thread_id);
	}
	const previous = node_id_to_thread_id.get(node_id);
	node_id_to_thread_id.set(node_id, {
		threadId: thread_id,
		listener,
	});
	previous?.listener?.();
	for (const [other_node_id, { listener }] of node_id_to_thread_id) {
		if (node_id === other_node_id) continue;
		listener?.();
	}
}
