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
// Past this many tracked addresses a new one is admitted untracked: memory stays bounded, no tracked bucket is
// evicted (eviction would refund it), and a flood of distinct sources cannot starve the legitimate new ones the
// way a shared overflow bucket would. A per-address limit cannot bound a distributed flood in any case.
const MAX_TRACKED_ADDRESSES = 100_000;
const DROP_REPORT_INTERVAL_MS = 60_000;

/**
 * Admission for new connections from each source address, or undefined when `limit` sets no
 * positive `perSecond`. A connection with no address (a Unix socket with no PROXY header) is admitted.
 * Drops are not logged one by one: a flood is exactly when a log line per connection costs most.
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
	let lastPruneAt = clock();
	let dropped = 0;
	let droppedSince = lastPruneAt;
	return (address) => {
		if (!address) return true;
		const now = clock();
		if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
			lastPruneAt = now;
			// only a full bucket is indistinguishable from a new one
			for (const [key, bucket] of buckets) if (bucket.isFull()) buckets.delete(key);
		}
		const key = sourceAddressKey(address);
		let bucket = buckets.get(key);
		if (!bucket) {
			if (buckets.size >= MAX_TRACKED_ADDRESSES) return true;
			bucket = new TokenBucket(perSecond, burst, clock);
			buckets.set(key, bucket);
		}
		if (bucket.tryConsume()) return true;
		dropped++;
		if (now - droppedSince >= DROP_REPORT_INTERVAL_MS || dropped === 1) {
			harperLogger.warn?.(
				`${description}: dropped ${dropped} connection(s) over the connection rate limit (${perSecond}/s, burst ${burst}, per source address) in the last ${Math.round((now - droppedSince) / 1000)}s`
			);
			dropped = 0;
			droppedSince = now;
		}
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

/** Wrap a connection listener so it only sees admitted sockets. */
export function gateListener(listener: (socket: any) => void, admit: ConnectionAdmission): (socket: any) => void {
	return (socket) => {
		if (admit(socket.remoteAddress)) listener(socket);
		else {
			socket.on('error', ignoreError);
			socket.destroy();
		}
	};
}

// An RST leaves no TIME_WAIT socket behind on this side, which matters at flood rates. resetAndDestroy throws
// for a non-TCP handle and emits an unhandled error on a socket with no handle, so either falls back to destroy.
function resetConnection(socket: any): void {
	// no listener has attached an error handler yet
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
