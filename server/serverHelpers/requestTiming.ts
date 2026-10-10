export interface TimedRequest {
	httpVersionMajor?: number;
	socket?: TimedSocket | null;
	receivedAt?: number;
}

export interface TimedSocket {
	requestSeenAt?: number;
	parser?: HttpParserLike | null;
}

interface HttpParserLike {
	socket?: TimedSocket | null;
	constructor: { kOnMessageBegin?: number };
	[slot: number]: unknown;
}

function onMessageBegin(this: HttpParserLike) {
	const socket = this.socket;
	if (socket) socket.requestSeenAt = performance.now();
}

/**
 * Hooks the parser's message-begin callback, which Node's own listener leaves empty: it fires at
 * the first bytes of every message, before the headers are complete and without adding a socket
 * `data` listener, which would move the parser off its consumed native stream.
 */
export function watchRequestArrival(socket: TimedSocket | undefined | null): void {
	const parser = socket?.parser;
	const slot = parser?.constructor?.kOnMessageBegin;
	if (typeof slot !== 'number') return;
	parser[slot] = onMessageBegin;
}

/**
 * Moves the socket's arrival stamp onto the request as `receivedAt`, falling back to now where
 * there is none: HTTP/2 sessions and other transports without a Node HTTP parser.
 */
export function startRequestTimer(request: TimedRequest): number {
	const socket = request.httpVersionMajor === 2 ? undefined : request.socket;
	let receivedAt = socket?.requestSeenAt;
	if (socket) socket.requestSeenAt = undefined;
	if (receivedAt === undefined) receivedAt = performance.now();
	request.receivedAt = receivedAt;
	return receivedAt;
}
