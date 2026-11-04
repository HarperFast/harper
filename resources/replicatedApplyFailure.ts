import { onRemovedDB } from './databases.ts';
import { logger } from '../utility/logging/logger.ts';
import { contextStorage } from './transaction.ts';

export interface ReplicatedApplyFailure {
	readonly database: string;
	readonly table?: string;
	readonly nodeId: number;
	readonly position: number;
	readonly localTime?: number;
	readonly error: unknown;
}

export type ReplicatedApplyFailureListener = (failure: ReplicatedApplyFailure) => void | Promise<void>;

const listenersByDatabase = new Map<string, Set<ReplicatedApplyFailureListener>>();
let watchingDatabaseRemoval = false;

export function registerReplicatedApplyFailureListener(
	database: string,
	listener: ReplicatedApplyFailureListener
): void {
	if (!watchingDatabaseRemoval) {
		onRemovedDB((database) => listenersByDatabase.delete(database));
		watchingDatabaseRemoval = true;
	}
	let listeners = listenersByDatabase.get(database);
	if (!listeners) listenersByDatabase.set(database, (listeners = new Set()));
	listeners.add(listener);
}

export function unregisterReplicatedApplyFailureListener(
	database: string,
	listener: ReplicatedApplyFailureListener
): void {
	const listeners = listenersByDatabase.get(database);
	listeners?.delete(listener);
	if (listeners?.size === 0) listenersByDatabase.delete(database);
}

export async function notifyReplicatedApplyFailure(
	database: string,
	event: { table?: string; nodeId?: number; localTime?: number },
	position: number | undefined,
	error: unknown,
	table?: string
): Promise<void> {
	if (listenersByDatabase.size === 0) return;
	try {
		if (typeof event?.nodeId !== 'number' || typeof position !== 'number') return;
		const listeners = listenersByDatabase.get(database);
		if (!listeners) return;
		const failure: ReplicatedApplyFailure = Object.freeze({
			database,
			table: event.table ?? table,
			nodeId: event.nodeId,
			position,
			localTime: event.localTime,
			error,
		});
		for (const listener of [...listeners]) {
			try {
				await contextStorage.exit(() => listener(failure));
			} catch (error) {
				logListenerFailure(database, error);
			}
		}
	} catch (error) {
		logListenerFailure(database, error);
	}
}

function logListenerFailure(database: string, error: unknown): void {
	try {
		logger.error?.('replicated apply failure listener failed', database, error);
	} catch {}
}
