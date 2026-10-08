import type { IncomingMessage } from 'node:http';

export interface TimedRequest extends Partial<Pick<IncomingMessage, 'httpVersionMajor' | 'complete'>> {
	socket?: TimedSocket | null;
	receivedAt?: number;
}

export interface TimedSocket {
	requestSeenAt?: number;
	currentRequest?: TimedRequest;
	prependListener?: (event: string, listener: (chunk: unknown) => void) => unknown;
}

/**
 * Body chunks of the request in flight must not restamp: a stamp is taken only while the socket
 * is between requests, which is before any request or once the parser has completed the last one.
 */
function markRequestSeen(this: TimedSocket) {
	if (this.requestSeenAt === undefined && this.currentRequest?.complete !== false) {
		this.requestSeenAt = performance.now();
	}
}

/** Stamps the socket with the arrival of each request's first bytes; runs ahead of the HTTP parser. */
export function watchRequestArrival(socket: TimedSocket | undefined | null): void {
	if (typeof socket?.prependListener !== 'function') return;
	socket.prependListener('data', markRequestSeen);
}

/**
 * Moves the socket's arrival stamp onto the request as `receivedAt`, falling back to now where
 * there is none: HTTP/2 sessions and other transports that surface no socket data events.
 */
export function startRequestTimer(request: TimedRequest): number {
	const socket = request.httpVersionMajor === 2 ? undefined : request.socket;
	let receivedAt = socket?.requestSeenAt;
	if (socket) {
		socket.requestSeenAt = undefined;
		socket.currentRequest = request;
	}
	if (receivedAt === undefined) receivedAt = performance.now();
	request.receivedAt = receivedAt;
	return receivedAt;
}
