/**
 * Load helpers for integration specs whose assertions depend on reaching more than one HTTP worker.
 *
 * Harper's HTTP workers share the port through SO_REUSEPORT (`server/http.ts`), so the kernel picks
 * the serving worker once per TCP connection, and `fetch()` keep-alive therefore pins a serial
 * request stream to one or two workers however many exist. Fresh connections only restore the
 * kernel's choice; `observeEveryWorker` is what makes coverage a fact, because a request that may
 * reach another worker proves nothing about the one it missed.
 */

export function fetchOnNewConnection(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Connection', 'close');
	return fetch(input, { ...init, headers });
}

export interface ObserveEveryWorkerOptions {
	/** Workers the instance was configured with — every one must answer before the caller asserts. */
	workerCount: number;
	/** Requests per round, issued together so the post-write observation window stays tight. */
	concurrency?: number;
	/** Request budget before failing; the default sits far above what per-connection routing needs. */
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
	while (seen.size < workerCount && responses.length < maxRequests) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		const round = Math.min(concurrency, maxRequests - responses.length);
		const gathered = await Promise.all(Array.from({ length: round }, () => settleWithin(request(), remainingMs)));
		for (const response of gathered) {
			const workerId = workerIdOf(response);
			if (!Number.isInteger(workerId)) {
				throw new Error(`observeEveryWorker: response carried no worker id (got ${JSON.stringify(workerId)})`);
			}
			seen.add(workerId);
			responses.push(response);
		}
	}
	if (seen.size < workerCount) {
		throw new Error(
			`observeEveryWorker: reached ${seen.size} of ${workerCount} workers in ${responses.length} requests ` +
				`(saw [${[...seen].sort((a, b) => a - b).join(',')}]) — the suite's cross-worker claim cannot be ` +
				`checked on the workers it never reached`
		);
	}
	return responses;
}

/** Without this a request that never settles hangs the shard, since the budget only counts requests. */
function settleWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`observeEveryWorker: a request did not settle within ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([pending, expiry]).finally(() => clearTimeout(timer));
}
