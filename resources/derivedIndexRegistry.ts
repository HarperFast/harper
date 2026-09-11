const registrations = new WeakMap<object, Map<number, number>>();
const admissions = new WeakMap<object, Map<number, Array<() => string | undefined>>>();

/** `admission` returns a reason while writes to these tables must be rejected. */
export function registerDerivedIndexTables(
	auditStore: object,
	tableIds: Iterable<number>,
	admission?: () => string | undefined
): () => void {
	const registeredTableIds = new Set(tableIds);
	let counts = registrations.get(auditStore);
	if (!counts) registrations.set(auditStore, (counts = new Map()));
	for (const tableId of registeredTableIds) counts.set(tableId, (counts.get(tableId) ?? 0) + 1);
	let checks: Map<number, Array<() => string | undefined>> | undefined;
	if (admission) {
		checks = admissions.get(auditStore);
		if (!checks) admissions.set(auditStore, (checks = new Map()));
		for (const tableId of registeredTableIds) {
			let byTable = checks.get(tableId);
			if (!byTable) checks.set(tableId, (byTable = []));
			byTable.push(admission);
		}
	}
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		for (const tableId of registeredTableIds) {
			const count = counts!.get(tableId);
			if (count === 1) counts!.delete(tableId);
			else if (count) counts!.set(tableId, count - 1);
			if (admission && checks) {
				const byTable = checks.get(tableId);
				const index = byTable?.indexOf(admission) ?? -1;
				if (byTable && index >= 0) byTable.splice(index, 1);
				if (byTable?.length === 0) checks.delete(tableId);
			}
		}
		if (counts!.size === 0) registrations.delete(auditStore);
		if (checks?.size === 0) admissions.delete(auditStore);
	};
}

export function hasDerivedIndexRegistration(auditStore: object, tableId: number): boolean {
	return registrations.get(auditStore)?.has(tableId) ?? false;
}

/** The reason a write to this table must currently be rejected, or undefined when writes are admitted. */
export function derivedIndexWriteRejection(auditStore: object, tableId: number): string | undefined {
	const byTable = admissions.get(auditStore)?.get(tableId);
	if (!byTable) return;
	for (let i = 0; i < byTable.length; i++) {
		const reason = byTable[i]();
		if (reason) return reason;
	}
}
