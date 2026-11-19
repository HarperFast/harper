import { PassThrough, Readable } from 'node:stream';

export interface ProgressEvent {
	event: string;
	data: unknown;
}

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * Lightweight pub-sub used to report phase/install/replicate events from a long-running
 * operation back to the HTTP layer. We deliberately don't use Node's EventEmitter here:
 * we only need broadcast semantics for a small set of event types, and we want the
 * `emit(event, data)` shape that matches the SSE wire format directly.
 */
export class ProgressEmitter {
	private listeners: ProgressListener[] = [];

	/**
	 * Set by {@link createSSEResponseStream} to a signal that aborts when the client
	 * disconnects. Open-ended operations (e.g. a live log tail that never returns on its own)
	 * read this to stop producing events and resolve, instead of running until process exit.
	 */
	signal?: AbortSignal;

	/**
	 * Backpressure signal for open-ended producers. {@link createSSEResponseStream} sets this
	 * `true` when the underlying SSE stream's write buffer is full and clears it on `drain`. A
	 * producer that can outrun a slow client (e.g. a log tail on a busy file) should await
	 * {@link whenWritable} before emitting more, so buffered frames can't grow without bound.
	 * Bounded producers (deploy) simply never check it.
	 */
	paused = false;
	private drainWaiters: Array<() => void> = [];

	/** Resolves once the SSE stream can accept more writes (immediately when not paused). */
	whenWritable(): Promise<void> {
		if (!this.paused) return Promise.resolve();
		return new Promise((resolve) => this.drainWaiters.push(resolve));
	}

	/** Called by the SSE wrapper on `drain` (and on teardown) to release awaiting producers. */
	resume(): void {
		this.paused = false;
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const waiter of waiters) waiter();
	}

	emit(event: string, data: unknown): void {
		// Snapshot before iteration so a listener that unsubscribes itself during dispatch
		// doesn't shift indexes underneath us.
		const snapshot = this.listeners.slice();
		for (const listener of snapshot) {
			try {
				listener({ event, data });
			} catch {
				// A buggy listener must never break the operation. Swallow and continue.
			}
		}
	}

	subscribe(listener: ProgressListener): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}
}

/**
 * Wrap a long-running operation so its progress events stream back as Server-Sent Events.
 *
 * The returned Readable emits one SSE message per `emitter.emit(...)` call, then a final
 * `done` (or `error`) event with the operation's result, then ends. The caller is
 * expected to set Content-Type: text/event-stream on the response.
 */
export function createSSEResponseStream(emitter: ProgressEmitter, operation: () => Promise<unknown>): Readable {
	const stream = new PassThrough();
	// Prime the stream with an SSE comment line so the response body is non-empty by the time
	// Fastify starts piping. Without this, Fastify buffers the PassThrough's internal queue
	// until its end and only flushes the final chunk to the wire — making intermediate
	// progress events invisible to the client. The comment ": ..." is a valid SSE record
	// that consumers ignore, so it's safe filler.
	stream.write(`: stream open\n\n`);

	// Give the operation a way to observe client disconnect. `cleanup` runs when the stream
	// closes/ends (and after the operation settles); aborting there lets an open-ended
	// operation like a log tail stop and resolve rather than leak until the process exits.
	const abortController = new AbortController();
	emitter.signal = abortController.signal;

	let active = true;
	let errorEmitted = false;
	const unsubscribe = emitter.subscribe((event) => {
		if (active) {
			// A `false` return means the stream's buffer is over its high-water mark; flag it so
			// producers that check `whenWritable()` back off until the 'drain' below clears it.
			const canWriteMore = writeSSE(stream, event);
			if (!canWriteMore) emitter.paused = true;
			if (event.event === 'error') errorEmitted = true;
		}
	});
	stream.on('drain', () => emitter.resume());

	const cleanup = () => {
		if (active) {
			active = false;
			unsubscribe();
			abortController.abort();
			// Release any producer awaiting drain so the operation can settle instead of hanging.
			emitter.resume();
		}
	};

	// If the client disconnects (Ctrl-C, network drop) stop writing to the stream and
	// release the emitter subscription so it doesn't accumulate for the operation lifetime.
	stream.on('close', cleanup);
	stream.on('end', cleanup);

	operation()
		.then((result) => {
			if (active) writeSSE(stream, { event: 'done', data: { result } });
		})
		.catch((err) => {
			// Only emit a framework-level error event if the operation itself didn't already
			// emit one (with richer context like phase) through the emitter subscriber above.
			if (active && !errorEmitted) {
				writeSSE(stream, {
					event: 'error',
					data: {
						message: err?.message ?? String(err),
						code: err?.statusCode ?? err?.code,
					},
				});
			}
		})
		.finally(() => {
			cleanup();
			stream.end();
		});

	return stream;
}

/**
 * Write one SSE record; returns `false` if any of its writes pushed the buffer past its
 * high-water mark (so a dense multi-line payload that tips the buffer on an early `data:`
 * line is still detected, not just the final `\n`). `stream.write(...)` is always the left
 * operand so every line is written regardless of the accumulated backpressure flag.
 */
function writeSSE(stream: PassThrough, event: ProgressEvent): boolean {
	// `JSON.stringify(undefined)` returns the `undefined` primitive, not a string, so fall back to
	// '' via `??` — an event carrying no data still writes a valid (empty-payload) record instead
	// of throwing a TypeError deep in the write path. An explicit `null` is preserved as the JSON
	// value `null` for consumers replaying persisted events.
	const data = typeof event.data === 'string' ? event.data : (JSON.stringify(event.data) ?? '');
	let canWrite = stream.write(`event: ${event.event}\n`);
	for (const line of data.split(/\r?\n/)) {
		canWrite = stream.write(`data: ${line}\n`) && canWrite;
	}
	return stream.write('\n') && canWrite;
}
