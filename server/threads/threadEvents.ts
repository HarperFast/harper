const messageListeners: any[] = [];
const listenersByType = new Map();
const messagesQueuedByType = new Map();

export function onMessageFromWorkers(listener: any) {
	messageListeners.push(listener);
}

export function onMessageByType(type: string, listener: any) {
	let listeners = listenersByType.get(type);
	if (!listeners) {
		listeners = [];
		listenersByType.set(type, listeners);
	}
	listeners.push(listener);
	let queuedMessages = messagesQueuedByType.get(type);
	if (queuedMessages) {
		for (let message of queuedMessages) {
			listener(message);
		}
		messagesQueuedByType.delete(type);
	}
}

export function getMessageListeners() {
    return messageListeners;
}

export function getListenersByType() {
    return listenersByType;
}

export function getMessagesQueuedByType() {
    return messagesQueuedByType;
}
