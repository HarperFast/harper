import { threadId, workerData } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';

type DatabaseDropPreparation = {
	id: string;
	ownerThreadId: number;
	databaseName: string;
	ownerExited?: boolean;
	preparationTask?: Promise<void>;
};

const inheritedDatabaseDropPreparations = (workerData?.databaseDropPreparations ?? []).filter(
	// Main reaches a child through parentPort rather than addThreadIds; worker owners must be in the initial peer topology.
	([, preparation]: [string, DatabaseDropPreparation]) =>
		preparation.ownerThreadId === 0 || workerData?.addThreadIds?.includes(preparation.ownerThreadId)
);
const databaseDropPreparations = new Map<string, DatabaseDropPreparation>(inheritedDatabaseDropPreparations);

class DatabaseDroppingError extends Error {
	statusCode = 409;
	code = 'DATABASE_DROP_IN_PROGRESS';
	constructor(databaseName: string) {
		super(`Database '${databaseName}' is already being dropped`);
		this.name = 'DatabaseDroppingError';
	}
}

export function claimDatabaseDropPreparation(
	rootPath: string,
	preparationId: string,
	ownerThreadId = threadId,
	databaseName = rootPath
): boolean {
	const current = databaseDropPreparations.get(rootPath);
	if (current?.id === preparationId) return false;
	if (current) {
		throw new DatabaseDroppingError(current.databaseName);
	}
	databaseDropPreparations.set(rootPath, { id: preparationId, ownerThreadId, databaseName });
	return true;
}

export function releaseDatabaseDropPreparation(rootPath: string, preparationId: string): void {
	if (databaseDropPreparations.get(rootPath)?.id === preparationId) databaseDropPreparations.delete(rootPath);
}

export function claimDatabaseDropPreparations(
	rootPaths: Iterable<string>,
	preparationId: string,
	ownerThreadId = threadId,
	databaseName?: string
): void {
	const claimed: string[] = [];
	try {
		for (const rootPath of new Set(rootPaths)) {
			if (claimDatabaseDropPreparation(rootPath, preparationId, ownerThreadId, databaseName)) claimed.push(rootPath);
		}
	} catch (error) {
		for (const rootPath of claimed) releaseDatabaseDropPreparation(rootPath, preparationId);
		throw error;
	}
}

export function releaseDatabaseDropPreparations(rootPaths: Iterable<string>, preparationId: string): void {
	for (const rootPath of new Set(rootPaths)) releaseDatabaseDropPreparation(rootPath, preparationId);
}

export function trackDatabaseDropPreparationTask(
	rootPath: string,
	preparationId: string,
	preparationTask: Promise<void>
): void {
	const preparation = databaseDropPreparations.get(rootPath);
	if (preparation?.id !== preparationId) return;
	preparation.preparationTask = preparationTask;
	if (preparation.ownerExited) {
		const release = () => releaseDatabaseDropPreparation(rootPath, preparationId);
		preparationTask.then(release, release);
	}
}

export function handleDatabaseDropPreparationOwnerExit(ownerThreadId: number): void {
	for (const [rootPath, preparation] of databaseDropPreparations) {
		if (preparation.ownerThreadId !== ownerThreadId) continue;
		preparation.ownerExited = true;
		if (preparation.preparationTask) {
			const release = () => releaseDatabaseDropPreparation(rootPath, preparation.id);
			preparation.preparationTask.then(release, release);
		} else databaseDropPreparations.delete(rootPath);
	}
}

export function databaseDropPrepared(rootPath: string): boolean {
	return databaseDropPreparations.size > 0 && databaseDropPreparations.has(rootPath);
}

export function databaseDropPreparedWithin(directoryPath: string): boolean {
	if (databaseDropPreparations.size === 0) return false;
	const normalizedDirectoryPath = resolve(directoryPath);
	for (const rootPath of databaseDropPreparations.keys()) {
		if (resolve(dirname(rootPath)) === normalizedDirectoryPath) return true;
	}
	return false;
}

export function databaseDropPreparationSnapshot(): [
	string,
	Pick<DatabaseDropPreparation, 'id' | 'ownerThreadId' | 'databaseName'>,
][] {
	const snapshot: [string, Pick<DatabaseDropPreparation, 'id' | 'ownerThreadId' | 'databaseName'>][] = [];
	for (const [rootPath, preparation] of databaseDropPreparations) {
		if (!preparation.ownerExited)
			snapshot.push([
				rootPath,
				{ id: preparation.id, ownerThreadId: preparation.ownerThreadId, databaseName: preparation.databaseName },
			]);
	}
	return snapshot;
}
