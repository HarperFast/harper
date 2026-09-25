import { threadId, workerData } from 'node:worker_threads';

type DatabaseDropPreparation = {
	id: string;
	ownerThreadId: number;
	ownerExited?: boolean;
	preparationTask?: Promise<void>;
};

const databaseDropPreparations = new Map<string, DatabaseDropPreparation>(workerData?.databaseDropPreparations ?? []);

class DatabaseDroppingError extends Error {
	statusCode = 409;
	code = 'DATABASE_DROP_IN_PROGRESS';
	constructor(databaseName: string) {
		super(`Database '${databaseName}' is already being dropped`);
		this.name = 'DatabaseDroppingError';
	}
}

export function claimDatabaseDropPreparation(
	databaseName: string,
	preparationId: string,
	ownerThreadId = threadId
): boolean {
	const current = databaseDropPreparations.get(databaseName);
	if (current?.id === preparationId) return false;
	if (current) {
		throw new DatabaseDroppingError(databaseName);
	}
	databaseDropPreparations.set(databaseName, { id: preparationId, ownerThreadId });
	return true;
}

export function releaseDatabaseDropPreparation(databaseName: string, preparationId: string): void {
	if (databaseDropPreparations.get(databaseName)?.id === preparationId) databaseDropPreparations.delete(databaseName);
}

export function trackDatabaseDropPreparationTask(
	databaseName: string,
	preparationId: string,
	preparationTask: Promise<void>
): void {
	const preparation = databaseDropPreparations.get(databaseName);
	if (preparation?.id !== preparationId) return;
	preparation.preparationTask = preparationTask;
	if (preparation.ownerExited) {
		const release = () => releaseDatabaseDropPreparation(databaseName, preparationId);
		preparationTask.then(release, release);
	}
}

export function handleDatabaseDropPreparationOwnerExit(ownerThreadId: number): void {
	for (const [databaseName, preparation] of databaseDropPreparations) {
		if (preparation.ownerThreadId !== ownerThreadId) continue;
		preparation.ownerExited = true;
		// A peer may still be closing its local handles when the owner dies. Keep that peer fenced
		// until its own preparation settles; a worker created afterward has no old handles to drain.
		if (preparation.preparationTask) {
			const release = () => releaseDatabaseDropPreparation(databaseName, preparation.id);
			preparation.preparationTask.then(release, release);
		} else databaseDropPreparations.delete(databaseName);
	}
}

export function databaseDropPrepared(databaseName: string): boolean {
	return databaseDropPreparations.size > 0 && databaseDropPreparations.has(databaseName);
}

export function databaseDropPreparationSnapshot(): [string, Pick<DatabaseDropPreparation, 'id' | 'ownerThreadId'>][] {
	const snapshot: [string, Pick<DatabaseDropPreparation, 'id' | 'ownerThreadId'>][] = [];
	for (const [databaseName, preparation] of databaseDropPreparations) {
		if (!preparation.ownerExited)
			snapshot.push([databaseName, { id: preparation.id, ownerThreadId: preparation.ownerThreadId }]);
	}
	return snapshot;
}
