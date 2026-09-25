import { workerData } from 'node:worker_threads';

const databaseDropPreparations = new Map<string, string>(workerData?.databaseDropPreparations ?? []);

class DatabaseDroppingError extends Error {
	statusCode = 409;
	code = 'DATABASE_DROP_IN_PROGRESS';
	constructor(databaseName: string) {
		super(`Database '${databaseName}' is already being dropped`);
		this.name = 'DatabaseDroppingError';
	}
}

export function claimDatabaseDropPreparation(databaseName: string, preparationId: string): boolean {
	const current = databaseDropPreparations.get(databaseName);
	if (current === preparationId) return false;
	if (current) {
		throw new DatabaseDroppingError(databaseName);
	}
	databaseDropPreparations.set(databaseName, preparationId);
	return true;
}

export function releaseDatabaseDropPreparation(databaseName: string, preparationId: string): void {
	if (databaseDropPreparations.get(databaseName) === preparationId) databaseDropPreparations.delete(databaseName);
}

export function databaseDropPrepared(databaseName: string): boolean {
	return databaseDropPreparations.has(databaseName);
}

export function databaseDropPreparationSnapshot(): [string, string][] {
	return [...databaseDropPreparations];
}
