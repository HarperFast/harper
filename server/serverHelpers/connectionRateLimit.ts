import harperLogger from '../../utility/logging/harper_logger.ts';
import { TokenBucket, sourceAddressKey } from './tokenBucket.ts';

export interface ConnectionRateLimit {
	/** New connections per second admitted from one source address, per worker thread; 0 or absent disables the limit */
	perSecond?: number;
	/** Connections one source address can open back to back before `perSecond` applies; defaults to `perSecond` */
	burst?: number;
}

export type ConnectionAdmission = (address: string | undefined) => boolean;

const PRUNE_INTERVAL_MS = 10_000;
// Each accept advances the prune this many entries, so no single accept pays for the whole map
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
	let pruning: Iterator<[string, TokenBucket]> | undefined;
	let lastPruneAt = clock();
	let dropped = 0;
	let untracked = 0;
	let lastReportAt = -Infinity;

	function pruneStep(entries: Iterator<[string, TokenBucket]>) {
		for (let i = 0; i < PRUNE_STEP; i++) {
			const next = entries.next();
			if (next.done) {
				pruning = undefined;
				return;
			}
			// only a full bucket is indistinguishable from a new one
			if (next.value[1].isFull()) buckets.delete(next.value[0]);
		}
	}

	function report(now: number) {
		if (now - lastReportAt < REPORT_INTERVAL_MS) return;
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
			pruning = buckets.entries();
		}
		if (pruning) pruneStep(pruning);
		const key = sourceAddressKey(address);
		let bucket = buckets.get(key);
		if (!bucket) {
			if (buckets.size >= MAX_TRACKED_ADDRESSES) {
				untracked++;
				report(now);
				return true;
			}
			bucket = new TokenBucket(perSecond, burst, clock);
			buckets.set(key, bucket);
		}
		if (bucket.tryConsume()) return true;
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

export function gateListener(listener: (socket: any) => void, admit: ConnectionAdmission): (socket: any) => void {
	return (socket) => {
		if (admit(socket.remoteAddress)) listener(socket);
		else resetConnection(socket);
	};
}

// An RST leaves no TIME_WAIT socket behind on this side, which matters at flood rates. resetAndDestroy throws
// for a non-TCP handle (a Unix socket) and emits an error on a socket with no handle, so both fall back to
// destroy; no listener has attached an error handler to a refused socket.
function resetConnection(socket: any): void {
	socket.on('error', ignoreError);
	if (socket._handle && typeof socket.resetAndDestroy === 'function') {
		try {
			socket.resetAndDestroy();
			return;
		} catch {}
	}
	socket.destroy();
}

function ignoreError() {}
