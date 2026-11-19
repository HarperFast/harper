/**
 * Load helpers for integration specs whose assertions depend on reaching more than one HTTP worker.
 *
 * Harper's HTTP workers share the port through SO_REUSEPORT (`server/http.ts`), so the kernel picks
 * the serving worker once per TCP connection, and `fetch()` keep-alive therefore pins a serial
 * request stream to one or two workers however many exist. Fresh connections restore the kernel's
 * choice; `observeEveryWorker` turns that choice into coverage a suite can assert on.
 */

export function fetchOnNewConnection(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Connection', 'close');
	return fetch(input, { ...init, headers });
}

export interface ObserveEveryWorkerOptions {
	workerCount: number;
	/** Issued together, so the window between the caller's write ack and its last read stays tight. */
	concurrency?: number;
	maxRequests?: number;
	timeoutMs?: number;
}

/**
 * Issue `request` in concurrent rounds until every configured worker has answered, returning every
 * response gathered, or fail naming the workers never reached. `request` must open a fresh
 * connection (`fetchOnNewConnection`); a keep-alive one would loop against one worker until the
 * budget ran out.
 */
export async function observeEveryWorker<T>(
	request: () => Promise<T>,
	workerIdOf: (response: T) => number,
	{
		workerCount,
		concurrency = workerCount,
		maxRequests = workerCount * 32,
		timeoutMs = 15_000,
	}: ObserveEveryWorkerOptions
): Promise<T[]> {
	const responses: T[] = [];
	const seen = new Set<number>();
	const deadline = Date.now() + timeoutMs;
	let issued = 0;
	while (seen.size < workerCount && issued < maxRequests) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		const round = Math.min(concurrency, maxRequests - issued);
		issued += round;
		const gathered = await Promise.allSettled(
			Array.from({ length: round }, () => settleWithin(request(), remainingMs))
		);
		for (const result of gathered) {
			if (result.status !== 'fulfilled') continue;
			const workerId = workerIdOf(result.value);
			if (!Number.isInteger(workerId)) {
				throw new Error(`observeEveryWorker: response carried no worker id (got ${JSON.stringify(workerId)})`);
			}
			seen.add(workerId);
			responses.push(result.value);
		}
		for (const result of gathered) {
			// A stalled sibling is only noise once its round has completed coverage; anything the
			// caller's own request threw (a 5xx, a connection error) still fails the suite.
			if (result.status !== 'rejected') continue;
			if (!(result.reason instanceof RequestStalled) || seen.size < workerCount) throw result.reason;
		}
	}
	if (seen.size < workerCount) {
		throw new Error(
			`observeEveryWorker: reached ${seen.size} of ${workerCount} workers in ${issued} requests ` +
				`(saw [${[...seen].sort((a, b) => a - b).join(',')}]) — the suite's cross-worker claim cannot be ` +
				`checked on the workers it never reached`
		);
	}
	return responses;
}

class RequestStalled extends Error {}

/** Without this a request that never settles hangs the shard, since the budget only counts requests. */
function settleWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new RequestStalled(`observeEveryWorker: a request did not settle within ${ms}ms`)),
			ms
		);
		timer.unref?.();
	});
	return Promise.race([pending, expiry]).finally(() => clearTimeout(timer));
}
