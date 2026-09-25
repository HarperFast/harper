import { workerData } from 'node:worker_threads';

const databaseDropPreparations = new Map<string, string>(workerData?.databaseDropPreparations ?? []);

export function claimDatabaseDropPreparation(databaseName: string, preparationId: string): boolean {
	const current = databaseDropPreparations.get(databaseName);
	if (current === preparationId) return false;
	if (current) {
		const error: any = new Error(`Database '${databaseName}' is already being dropped`);
		error.statusCode = 409;
		throw error;
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
