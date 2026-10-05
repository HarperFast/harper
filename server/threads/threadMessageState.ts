export const listenersByType = new Map<string, Array<(message: any, port?: any) => void> | null>();
export const messagesQueuedByType = new Map<string, any[]>();
export const messageListeners: Array<(message: any, port?: any) => void> = [];
export const threadExitListeners: Array<(...args: any[]) => void> = [];
export const workerHooks: {
	reconcile: (() => any) | null;
	runningApplications: () => any[];
	monitorListener?: () => void;
	resetRestartNeeded?: () => void;
} = { reconcile: null, runningApplications: () => [] };
