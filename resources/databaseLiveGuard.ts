const liveDatabaseGuard = Symbol('liveDatabaseGuard');
const baselineDatabaseGuard = Symbol('baselineDatabaseGuard');
export const REPLICATION_APPLY = Symbol('replicationApply');

export function setDatabaseLiveGuard(rootStore: object, guard: () => string | undefined): void {
	(rootStore as any)[liveDatabaseGuard] = guard;
}

export function databaseLiveHoldReason(rootStore: object | undefined): string | undefined {
	try {
		return (rootStore as any)?.[liveDatabaseGuard]?.();
	} catch {
		return 'sharding agreement is unavailable';
	}
}

export function setDatabaseBaselineGuard(rootStore: object, guard: () => string | undefined): void {
	(rootStore as any)[baselineDatabaseGuard] = guard;
}

export function isReplicationApply(transaction: any): boolean {
	const context = transaction?.getContext?.() ?? transaction?.root?.getContext?.();
	return context?.[REPLICATION_APPLY] === true;
}

export function databaseBaselineHoldReason(rootStore: object | undefined, transaction?: any): string | undefined {
	if (transaction?.isReplay || isReplicationApply(transaction)) return;
	try {
		return (rootStore as any)?.[baselineDatabaseGuard]?.();
	} catch {
		return 'sharding recovery evidence is unavailable';
	}
}
