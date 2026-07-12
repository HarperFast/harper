/**
 * SSE framing for the MCP server-push (GET) channel.
 *
 * The transport core hands the GET handler a semantic frame queue (an
 * `IterableEventQueue` of `{ event, data, id }` frames that also emits `'data'`
 * per push and `'close'` on teardown). Both HTTP servers Harper runs — Fastify
 * on the operations port, Harper's own HTTP server on the application port —
 * need that turned into a real Node `Readable` of SSE wire text before they will
 * stream it:
 *
 *   - Neither server drives a raw `IterableEventQueue`: Fastify sends headers
 *     then never pulls from it, so frames sit in the queue undelivered;
 *     Harper-HTTP would `Readable.from()` it and pipe unserialized objects.
 *   - Node also defers transmitting response headers (after `writeHead`) until
 *     the first body byte. An SSE channel yields nothing until a push fires, so
 *     a GET would hang with headers unsent until the first notification.
 *
 * `toSseStream` returns a primed `Readable` of SSE text. It is **event-driven**
 * (subscribes to the queue's `'data'`/`'close'` events), deliberately NOT an
 * async generator over the queue's async iterator: a generator suspended at an
 * `await` for the next frame cannot be torn down on client disconnect (Node
 * defers the generator's `.return()` until the pending await settles, which
 * never happens), which would leak the socket and the session-registry entry.
 * The `PassThrough` + subscribe + teardown shape mirrors the operations progress
 * stream (`server/serverHelpers/progressEmitter.ts` `createSSEResponseStream`).
 */
import { PassThrough, type Readable } from 'node:stream';

export interface SseFrame {
	event?: string;
	data?: unknown;
	id?: string;
}

/**
 * The MCP server-push source — the session's `IterableEventQueue` viewed as an
 * event emitter: `'data'` per pushed frame (subscribing also drains any frames
 * already buffered), `'close'` on session teardown (DELETE / superseding GET /
 * idle prune). All methods optional so a plain emitter/stub works in tests.
 */
export interface SseFrameSource {
	on?(event: 'data', listener: (frame: SseFrame) => void): unknown;
	off?(event: 'data', listener: (frame: SseFrame) => void): unknown;
	off?(event: 'close', listener: () => void): unknown;
	removeListener?(event: 'close', listener: () => void): unknown;
	once?(event: 'close', listener: () => void): unknown;
	emit?(event: 'close'): unknown;
}

/** Serialize one frame to SSE wire format (`event:`/`data:`/`id:` lines + blank line). */
export function serializeSseFrame(frame: SseFrame): string {
	let out = '';
	if (frame.event) out += `event: ${frame.event}\n`;
	if (frame.data !== undefined) {
		const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
		// SSE requires each line of a multi-line payload to carry its own `data:`
		// prefix. MCP frames are single-line JSON in practice, but split defensively
		// so a payload containing a literal newline can't break the framing.
		for (const line of data.split('\n')) out += `data: ${line}\n`;
	}
	if (frame.id) out += `id: ${frame.id}\n`;
	return `${out}\n`;
}

/**
 * Build a primed SSE `Readable` that streams the queue's frames and flushes per
 * frame. The leading comment forces response headers out immediately so the GET
 * establishes before any push; teardown is event-driven so a client disconnect
 * (stream destroy) unsubscribes and signals the queue's `'close'` for the
 * session registry, and a session `'close'` ends the stream.
 */
export function toSseStream(frames: SseFrameSource): Readable {
	const stream = new PassThrough();
	// A `Readable` with no `'error'` listener throws on `'error'`, crashing the
	// worker. The operations adapter pipes this stream manually and Harper's own
	// HTTP server (`server/http.ts`) pipes it for the application profile; neither
	// pipe forwards a source error to a handler. Attach a default guard here so an
	// error on either profile tears the stream down instead of crashing. The
	// operations adapter additionally destroys its raw socket on this event.
	stream.on('error', () => stream.destroy());
	// Prime: a comment line (clients ignore `:`-prefixed lines) makes the body
	// non-empty immediately so the HTTP server flushes headers and the GET opens.
	stream.write(': mcp stream open\n\n');

	const onData = (frame: SseFrame): void => {
		stream.write(serializeSseFrame(frame));
	};
	// Server-side teardown (DELETE / supersede / prune): the queue emits `'close'`,
	// so end the response. Mark it so the stream-`'close'` handler below does NOT
	// re-emit `'close'` on the queue — the source already emitted it, and a second
	// emit would show up as duplicate teardown to any `on('close')` listener.
	let sourceClosed = false;
	const onClose = (): void => {
		sourceClosed = true;
		stream.end();
	};
	frames.on?.('data', onData);
	frames.once?.('close', onClose);

	// Client/proxy disconnect → the server destroys this stream. Always unsubscribe
	// the data listener. If the source has not already closed (i.e. this is a
	// client-side teardown, not a reaction to the queue's own `'close'`), remove our
	// `onClose` listener and signal the queue so the session registry (which listens
	// for the queue's `'close'`) drops the entry.
	stream.once('close', () => {
		frames.off?.('data', onData);
		if (sourceClosed) return;
		if (frames.off) frames.off('close', onClose);
		else frames.removeListener?.('close', onClose);
		frames.emit?.('close');
	});
	return stream;
}
