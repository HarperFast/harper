import { AsyncLocalStorage } from 'node:async_hooks';

const operationAuthorizationState = new AsyncLocalStorage<boolean>();

export function runWithOperationAuthorizationBypass<T>(bypassAuth: boolean, callback: () => T): T {
	return operationAuthorizationState.run(bypassAuth === true, callback);
}

export function isOperationAuthorizationBypassed(): boolean {
	return operationAuthorizationState.getStore() === true;
}
