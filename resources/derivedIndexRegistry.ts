const registrations = new WeakMap<object, Map<number, number>>();
const admissions = new WeakMap<object, Map<number, Array<() => string | undefined>>>();
type LockStore = { status?: string; tryLock(key: string): boolean; unlock(key: string): void };
type FenceWaitOptions = { shouldContinue?: () => boolean; timeoutMilliseconds?: number };
const DEFAULT_FENCE_WAIT_MILLISECONDS = 70_000;

function fullTextClearLockKey(tableId: number): string {
	return `derived-index:fulltext:${tableId}:table-clear`;
}

function fullTextRetirementLockKey(tableName: string): string {
	return `derived-index:fulltext:${tableName}:retirement`;
}

/** Hold this node-wide fence for the full duration of an asynchronous table clear. */
export function acquireFullTextClearFence(rootStore: LockStore, tableId: number): (() => void) | undefined {
	const key = fullTextClearLockKey(tableId);
	if (!rootStore.tryLock(key)) return;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		rootStore.unlock(key);
	};
}

/** Probe without waiting; callers hold the schema lock so a clear cannot start between this and persistence. */
export function fullTextClearInProgress(rootStore: LockStore, tableId: number): boolean {
	const release = acquireFullTextClearFence(rootStore, tableId);
	if (!release) return true;
	release();
	return false;
}

/** Wait until the current clear releases its fence; callers retry admission afterwards. */
export function waitForFullTextClear(
	rootStore: LockStore,
	tableId: number,
	options?: FenceWaitOptions
): Promise<boolean> {
	return waitForFence(rootStore, () => acquireFullTextClearFence(rootStore, tableId), 'table clear', options);
}

/** Fence same-name recreation while a dropped table's native directories are being retired. */
export function acquireFullTextRetirementFence(rootStore: LockStore, tableName: string): (() => void) | undefined {
	const key = fullTextRetirementLockKey(tableName);
	if (!rootStore.tryLock(key)) return;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		rootStore.unlock(key);
	};
}

/** Probe under the schema lock so recreation cannot pass between the probe and catalog persistence. */
export function fullTextRetirementInProgress(rootStore: LockStore, tableName: string): boolean {
	const release = acquireFullTextRetirementFence(rootStore, tableName);
	if (!release) return true;
	release();
	return false;
}

/** Wait until the current retirement releases its fence; the caller must recheck its generation afterwards. */
export function waitForFullTextRetirement(
	rootStore: LockStore,
	tableName: string,
	options?: FenceWaitOptions
): Promise<boolean> {
	return waitForFence(
		rootStore,
		() => acquireFullTextRetirementFence(rootStore, tableName),
		`retirement of full-text storage for '${tableName}'`,
		options
	);
}

export function waitForFullTextRetirementLease(
	rootStore: LockStore,
	tableName: string,
	options?: FenceWaitOptions
): Promise<(() => void) | undefined> {
	return waitForFenceLease(
		rootStore,
		() => acquireFullTextRetirementFence(rootStore, tableName),
		`retirement of full-text storage for '${tableName}'`,
		options
	);
}

async function waitForFence(
	rootStore: LockStore,
	acquire: () => (() => void) | undefined,
	description: string,
	options: FenceWaitOptions = {}
): Promise<boolean> {
	const release = await waitForFenceLease(rootStore, acquire, description, options);
	if (!release) return false;
	release();
	return true;
}

async function waitForFenceLease(
	rootStore: LockStore,
	acquire: () => (() => void) | undefined,
	description: string,
	options: FenceWaitOptions = {}
): Promise<(() => void) | undefined> {
	const deadline = Date.now() + (options.timeoutMilliseconds ?? DEFAULT_FENCE_WAIT_MILLISECONDS);
	let retryDelayMilliseconds = 1;
	for (;;) {
		if (options.shouldContinue && !options.shouldContinue()) return;
		if (rootStore.status !== undefined && rootStore.status !== 'open')
			throw new Error(`Cannot wait for ${description} on a ${rootStore.status} store`);
		const release = acquire();
		if (release) return release;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, retryDelayMilliseconds));
		retryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, 50);
	}
}

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
