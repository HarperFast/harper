import { AsyncLocalStorage } from 'node:async_hooks';

interface OperationAuthorizationState {
	bypassAuth: boolean;
	apiOperation?: string;
}

const operationAuthorizationState = new AsyncLocalStorage<OperationAuthorizationState>();

// Shared, for the common case of no carrier to preserve.
const BYPASSED: OperationAuthorizationState = Object.freeze({ bypassAuth: true });
const ENFORCED: OperationAuthorizationState = Object.freeze({ bypassAuth: false });

export function runWithOperationAuthorizationBypass<T>(bypassAuth: boolean, callback: () => T): T {
	// An existing carrier survives: the enforced branch is not a bypass, and a job handler dispatching
	// a nested authorized operation must not lose its own operation identity.
	const apiOperation = operationAuthorizationState.getStore()?.apiOperation;
	if (apiOperation === undefined) {
		return operationAuthorizationState.run(bypassAuth === true ? BYPASSED : ENFORCED, callback);
	}
	return operationAuthorizationState.run(Object.freeze({ bypassAuth: bypassAuth === true, apiOperation }), callback);
}

/**
 * `apiOperation` MUST come from the same value that selected the code now running, so it cannot name
 * an operation other than the one executing. That is the entire basis for trusting it: a request
 * property would be forgeable, and on the direct-SQL path this check is the only gate.
 */
export function runWithDispatchedOperation<T>(apiOperation: string, callback: () => T): T {
	return operationAuthorizationState.run(
		Object.freeze({ bypassAuth: operationAuthorizationState.getStore()?.bypassAuth === true, apiOperation }),
		callback
	);
}

export function getOperationAuthorizationState(): OperationAuthorizationState | undefined {
	return operationAuthorizationState.getStore();
}

export function isOperationAuthorizationBypassed(): boolean {
	return operationAuthorizationState.getStore()?.bypassAuth === true;
}
