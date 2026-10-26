import type { RequestTarget, RequestTargetOrId } from '../resources/RequestTarget.ts';

// wait for a promise or plain object to resolve
export function when<T, R>(
	value: T | Promise<T>,
	callback: (value: T) => R,
	reject?: (error: any) => void
): R | Promise<R | void> {
	if ((value as Promise<T>)?.then) {
		return (value as Promise<T>).then(callback, reject);
	}
	return callback(value as T);
}

export function promiseNormalize<T>(returnValue: T | Promise<T>, target: RequestTargetOrId): T | Promise<T> {
	if (!(returnValue as Promise<T>)?.then && !(target as RequestTarget)?.syncAllowed) {
		return Promise.resolve(returnValue);
	}
	return returnValue;
}

export async function settleBeforeDeadline(
	promises: Iterable<PromiseLike<unknown>>,
	deadline: number,
	timeoutError: () => Error
): Promise<void> {
	const pending = [...promises];
	if (pending.length === 0) return;
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw timeoutError();
	let timer: NodeJS.Timeout;
	try {
		await Promise.race([
			Promise.allSettled(pending),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(timeoutError()), remaining);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}
