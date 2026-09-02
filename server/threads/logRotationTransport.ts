'use strict';

// Hands the log-rotation coordinator the thread mesh it needs, from this side of the dependency
// edge: manageThreads already imports harper_logger, so logging can never import manageThreads.

import { threadId } from 'node:worker_threads';
import { setRotationTransport } from '../../utility/logging/logGenerationCoordinator.ts';
import { broadcast, onMessageByType, onThreadExit } from './manageThreads.js';

// Assigned to the `threads` global by manageThreads.
declare const threads: {
	sendToThread(threadId: number, message: any): boolean;
	[index: number]: { threadId?: number };
	length: number;
};

setRotationTransport({
	threadId,
	broadcast(message) {
		broadcast(message);
	},
	sendToThread(target, message) {
		threads.sendToThread(target, message);
	},
	onMessage(type, handler) {
		onMessageByType(type, handler);
	},
	onThreadExit,
	peerThreadIds() {
		// Job workers included: they write to the log whether or not they take part in ITC gossip. The
		// deadlock that excludes them from the schema broadcast cannot happen here — the handler only
		// closes a descriptor, and no caller blocks its event loop on the answer.
		const ids = new Set<number>();
		for (let i = 0; i < threads.length; i++) {
			const peer = threads[i].threadId;
			if (peer !== undefined && peer !== threadId) ids.add(peer);
		}
		return ids;
	},
});
