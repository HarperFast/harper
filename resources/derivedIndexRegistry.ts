const registrations = new WeakMap<object, Map<number, number>>();

export function registerDerivedIndexTables(auditStore: object, tableIds: Iterable<number>): () => void {
	const registeredTableIds = new Set(tableIds);
	let counts = registrations.get(auditStore);
	if (!counts) registrations.set(auditStore, (counts = new Map()));
	for (const tableId of registeredTableIds) counts.set(tableId, (counts.get(tableId) ?? 0) + 1);
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		for (const tableId of registeredTableIds) {
			const count = counts!.get(tableId);
			if (count === 1) counts!.delete(tableId);
			else if (count) counts!.set(tableId, count - 1);
		}
		if (counts!.size === 0) registrations.delete(auditStore);
	};
}

export function hasDerivedIndexRegistration(auditStore: object, tableId: number): boolean {
	return registrations.get(auditStore)?.has(tableId) ?? false;
}
