import harperLogger from '../../utility/logging/harper_logger.ts';
import { TokenBucket, sourceAddressKey } from './tokenBucket.ts';

export interface ConnectionRateLimit {
	/** New connections per second admitted from one source address, per worker thread; 0 or absent disables the limit */
	perSecond?: number;
	/** Connections one source address can open back to back before `perSecond` applies; defaults to `perSecond` */
	burst?: number;
}

type ConnectionAdmission = (address: string | undefined) => boolean;

const PRUNE_INTERVAL_MS = 10_000;
// no single accept pays for sweeping the whole map
const PRUNE_STEP = 64;
// Past this many tracked addresses a new one is admitted untracked: memory stays bounded, no tracked bucket is
// evicted (eviction would refund it), and a flood of distinct sources cannot starve the legitimate new ones the
// way a shared overflow bucket would. A per-address limit cannot bound a distributed flood in any case.
const MAX_TRACKED_ADDRESSES = 100_000;
const REPORT_INTERVAL_MS = 60_000;

/**
 * Admission for new connections from each source address, or undefined when `limit` sets no
 * positive `perSecond`. A connection with no address (a Unix socket with no PROXY header) is admitted.
 * Drops are reported as a count at most once per interval: a flood is exactly when a log line per
 * connection costs most.
 */
export function createConnectionRateLimiter(
	limit: ConnectionRateLimit | undefined,
	description: string,
	clock: () => number = Date.now
): ConnectionAdmission | undefined {
	const perSecond = Number(limit?.perSecond);
	if (!(perSecond > 0)) return undefined;
	const burst = Math.max(1, Number(limit?.burst) > 0 ? Number(limit?.burst) : perSecond);
	const buckets = new Map<string, TokenBucket>();
	let pruning: Iterator<string> | undefined;
	let lastPruneAt = clock();
	let dropped = 0;
	let untracked = 0;
	let lastReportAt = -Infinity;
	let pendingReport: ReturnType<typeof setTimeout> | undefined;

	function pruneStep(keys: Iterator<string>, now: number) {
		for (let i = 0; i < PRUNE_STEP; i++) {
			const next = keys.next();
			if (next.done) {
				pruning = undefined;
				return;
			}
			// only a full bucket is indistinguishable from a new one
			if (buckets.get(next.value).isFull(now)) buckets.delete(next.value);
		}
	}

	function report(now: number) {
		if (now - lastReportAt < REPORT_INTERVAL_MS) {
			// a flood that ends inside the interval still gets its count logged
			pendingReport ??= setTimeout(
				() => {
					pendingReport = undefined;
					report(clock());
				},
				REPORT_INTERVAL_MS - (now - lastReportAt)
			).unref();
			return;
		}
		lastReportAt = now;
		if (dropped > 0) {
			harperLogger.warn?.(
				`${description}: dropped ${dropped} connection(s) over the connection rate limit (${perSecond}/s, burst ${burst}, per source address) since the last report`
			);
		}
		if (untracked > 0) {
			harperLogger.warn?.(
				`${description}: admitted ${untracked} connection(s) from new addresses without a rate limit, because ${MAX_TRACKED_ADDRESSES} addresses are already tracked`
			);
		}
		dropped = 0;
		untracked = 0;
	}

	return (address) => {
		if (!address) return true;
		const now = clock();
		if (!pruning && now - lastPruneAt >= PRUNE_INTERVAL_MS) {
			lastPruneAt = now;
			pruning = buckets.keys();
		}
		if (pruning) pruneStep(pruning, now);
		const key = sourceAddressKey(address);
		let bucket = buckets.get(key);
		if (!bucket) {
			if (buckets.size >= MAX_TRACKED_ADDRESSES) {
				untracked++;
				report(now);
				return true;
			}
			bucket = new TokenBucket(perSecond, burst, clock, now);
			buckets.set(key, bucket);
		}
		if (bucket.tryConsume(now)) return true;
		dropped++;
		report(now);
		return false;
	};
}

/**
 * Close a server's over-limit connections from inside its 'connection' emit, before any listener sees
 * them: a TLS server starts its handshake in a 'connection' listener, so a listener that destroys the
 * socket would still hand a dead socket to the handshake.
 */
export function gateConnectionEvents(server: any, admit: ConnectionAdmission): void {
	const emit = server.emit;
	server.emit = function (event: string | symbol, socket: any) {
		if (event === 'connection' && !admit(socket?.remoteAddress)) {
			resetConnection(socket);
			return false;
		}
		return emit.apply(this, arguments);
	};
}

/** `tcp`: the listener's sockets sit directly on a TCP handle, so a refused one can be reset with an RST */
export function gateListener(
	listener: (socket: any) => void,
	admit: ConnectionAdmission,
	tcp: boolean
): (socket: any) => void {
	return (socket) => {
		if (admit(socket.remoteAddress)) listener(socket);
		else if (tcp) resetConnection(socket);
		else {
			socket.on('error', ignoreError);
			socket.destroy();
		}
	};
}

// An RST leaves no TIME_WAIT socket behind on this side, which matters at flood rates. resetAndDestroy emits an
// error on a socket with no handle, so that falls back to destroy; no listener has attached an error handler to a
// refused socket.
function resetConnection(socket: any): void {
	socket.on('error', ignoreError);
	if (socket._handle && typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
	else socket.destroy();
}

function ignoreError() {}
