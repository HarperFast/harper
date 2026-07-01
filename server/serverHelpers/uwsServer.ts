/**
 * uWebSockets.js HTTP server adapter (SPIKE — github.com/HarperFast/harper issue #914).
 *
 * Creates a non-SSL uWS App on a Unix domain socket and bridges each request through
 * Harper's existing request pipeline: it builds a {@link UwsRequest} (the same duck-typed
 * shape as BunRequest), invokes the supplied `handler` (i.e. `httpChain[port]`), and
 * serializes the returned Harper response descriptor back onto the uWS HttpResponse.
 *
 * Intended for the plaintext-UDS-behind-symphony topology: TLS/mTLS/HTTP-2 are terminated
 * by symphony upstream, the real client IP arrives via X-Forwarded-For, so this server only
 * speaks plaintext HTTP/1.1 and never touches certificates.
 *
 * Wired into the UDS path in http.ts (getHTTPServer → uwsServeConfigs) and started in
 * threadServer.js when HARPER_UWS_UDS is set; `uWebSockets.js` is an optionalDependency
 * (ABI/platform-specific, built by CI). Response streaming is still collapsed to a buffer
 * upstream in makeUwsHandler — streaming bodies are a follow-up.
 */
import { STATUS_CODES } from 'node:http';
import { EventEmitter } from 'node:events';
import { UwsRequest } from './Request.ts';
import { Headers } from './Headers.ts';

// uWS has no npm package; it's installed from a GitHub tag and is platform/ABI-specific.
// Imported lazily so harper builds/loads on platforms without a uWS binary.
type UwsApp = any;
type UwsResponse = any;
type UwsRequestRaw = any;

export interface UwsServerOptions {
	/** Bind a Unix domain socket at this path (the symphony-fronted topology). */
	socketPath?: string;
	/** Bind a TCP port instead of a UDS (plaintext HTTP, e.g. the main http port). */
	port?: number;
	/** Optional host/interface for the TCP bind (defaults to all interfaces). */
	host?: string;
	secure?: boolean;
	/** httpChain[port]-style handler: (request) => Harper response descriptor (or undefined). */
	handler: (request: UwsRequest) => Promise<HarperResponse | undefined> | HarperResponse | undefined;
	/** Max bytes to buffer for a request body before rejecting (default 100 MiB, matching ws maxPayload). */
	maxBodyBytes?: number;
	/** Max WebSocket frame payload; falls back to maxBodyBytes when unset. */
	wsMaxPayload?: number;
	/**
	 * Optional WebSocket handler. When provided, uWS accepts upgrades on this app/port and calls this
	 * with a ws-library-shaped {@link UwsWebSocket} adapter plus the captured upgrade request, so
	 * Harper's existing websocket chain (auth + listeners) runs unchanged.
	 */
	wsHandler?: (ws: UwsWebSocket, upgrade: UwsUpgrade) => void;
}

export interface UwsUpgrade {
	url: string;
	headers: Record<string, string | string[]>;
	ip: string;
	adapter?: UwsWebSocket;
}

export interface HarperResponse {
	status?: number;
	headers?: Headers | Record<string, string | string[]>;
	body?: string | Buffer | Uint8Array | Iterable<any> | AsyncIterable<any> | { pipe?: any } | null;
	handlesHeaders?: boolean;
	wasCacheMiss?: boolean;
}

// uWS writeStatus() needs a full "<code> <reason>" line; an empty reason phrase is rejected by
// some reverse-proxy parsers, so fall back to "Unknown" for codes Node doesn't know.
const statusText = (s: number) => `${s} ${STATUS_CODES[s] ?? 'Unknown'}`;

export async function createUwsServer(options: UwsServerOptions): Promise<{ app: UwsApp; close: () => void }> {
	const { default: uWS } = await import('uWebSockets.js' as any);
	const {
		socketPath,
		port,
		host,
		secure = false,
		handler,
		wsHandler,
		wsMaxPayload,
		maxBodyBytes = 100 * 1024 * 1024,
	} = options;
	const app: UwsApp = uWS.App();

	// Accept WebSocket upgrades on this app/port when a ws handler is supplied. Registered before the
	// HTTP routes so uWS routes upgrade requests here; normal requests still fall through to app.get/any.
	if (wsHandler) registerWsBehavior(app, wsHandler, wsMaxPayload ?? maxBodyBytes);

	const onRequest = (res: UwsResponse, req: UwsRequestRaw, hasBody: boolean) => {
		// uWS HttpRequest is only valid synchronously inside this callback — copy everything now.
		const method = req.getMethod().toUpperCase();
		const query = req.getQuery();
		const url = req.getUrl() + (query ? '?' + query : '');
		const headers: Record<string, string | string[]> = {};
		req.forEach((k: string, v: string) => {
			// uWS calls this once per header line, so preserve repeats (e.g. multiple Cookie/Forwarded).
			const existing = headers[k];
			if (existing === undefined) headers[k] = v;
			else if (Array.isArray(existing)) existing.push(v);
			else headers[k] = [existing, v];
		});

		// Capture the peer address synchronously (res is only valid in this callback). Only populated for
		// the direct-TCP path, where it's authoritative; behind symphony on a UDS it's left unset so the
		// real client IP comes from X-Forwarded-For (UwsRequest.ip falls back to XFF only when no socket
		// address is set). request.ip feeds local-auth (security/auth.ts AUTHORIZE_LOCAL), rate limiting,
		// and logging.
		const ip = port != null ? normalizeAddress(Buffer.from(res.getRemoteAddressAsText()).toString()) : undefined;

		const ac = new AbortController();
		res.onAborted(() => ac.abort());

		const dispatch = (bodyBuffer?: Buffer) => {
			const request = new UwsRequest({ method, url, headers, secure, bodyBuffer, signal: ac.signal, ip });
			Promise.resolve(handler(request))
				.then((response) => {
					if (ac.signal.aborted) return;
					writeResponse(res, response, ac.signal, method);
				})
				.catch((error) => {
					if (ac.signal.aborted) return;
					const status = (error && error.statusCode) || 500;
					res.cork(() => {
						res.writeStatus(statusText(status));
						res.writeHeader('content-type', 'text/plain');
						res.end(String((error && error.message) || error));
					});
				});
		};

		if (hasBody) {
			let buf: Buffer | null = null;
			let total = 0;
			res.onData((chunk: ArrayBuffer, isLast: boolean) => {
				total += chunk.byteLength;
				if (total > maxBodyBytes) {
					if (!ac.signal.aborted) res.cork(() => res.writeStatus('413 Payload Too Large').end());
					ac.abort();
					return;
				}
				// uWS neuters/reuses the ArrayBuffer once this callback returns, and the body is read
				// asynchronously in the handler — so copy the bytes out now. `Buffer.from(arrayBuffer)`
				// would alias uWS's memory; wrapping in a Uint8Array first forces an owned copy.
				const part = Buffer.from(new Uint8Array(chunk));
				buf = buf ? Buffer.concat([buf, part]) : part;
				if (isLast) dispatch(buf ?? undefined);
			});
		} else {
			dispatch(undefined);
		}
	};

	// Route the known-bodyless methods so they dispatch immediately, and treat everything else —
	// including non-standard body-bearing methods like QUERY (REST vector search) — as having a
	// body. uWS still fires onData(len=0, isLast=true) for a bodyless request that lands on the
	// any() fallback, so this can't stall the connection.
	const bodyless = (res: UwsResponse, req: UwsRequestRaw) => onRequest(res, req, false);
	const withBody = (res: UwsResponse, req: UwsRequestRaw) => onRequest(res, req, true);
	app.get('/*', bodyless);
	app.head('/*', bodyless);
	app.options('/*', bodyless);
	app.connect('/*', bodyless);
	app.trace('/*', bodyless);
	app.any('/*', withBody);

	await new Promise<void>((resolve, reject) => {
		const onListen = (listenSocket: unknown) =>
			listenSocket ? resolve() : reject(new Error(`uWS failed to bind ${host ?? ''}:${port ?? socketPath}`));
		// uWS shares the port across workers (SO_REUSEPORT) by default, matching the Node reusePort path.
		if (port != null) {
			if (host) app.listen(host, port, onListen);
			else app.listen(port, onListen);
		} else {
			app.listen_unix(onListen, socketPath!);
		}
	});

	return {
		app,
		close: () => app.close(),
	};
}

// Write every response header except Content-Length (uWS derives that from end(body); for streaming
// there is no fixed length and it must be omitted so uWS uses chunked transfer encoding).
function writeHeaders(res: UwsResponse, headers: Headers): void {
	for (const [name, value] of headers) {
		if ((name as string).toLowerCase() === 'content-length') continue;
		if (Array.isArray(value)) for (const v of value) res.writeHeader(name, String(v));
		else if (value != null) res.writeHeader(name, String(value));
	}
}

function writeResponse(
	res: UwsResponse,
	response: HarperResponse | undefined,
	signal?: AbortSignal,
	method?: string
): void {
	if (!response) {
		res.cork(() => res.writeStatus('404 Not Found').end('Not found\n'));
		return;
	}
	const status = response.status || 200;
	// A HEAD response must carry no body. The REST layer already nulls it, but uWS (unlike Node's
	// ServerResponse) has no HEAD guard, so enforce it here for any handler that returns one.
	const isHead = method === 'HEAD';
	const body = isHead ? null : response.body;

	// Normalize headers to a Harper Headers instance so we can iterate uniformly.
	const headers = response.headers instanceof Headers ? response.headers : new Headers(response.headers as any);

	// Streaming body (Node stream / normalized async-iterable): write incrementally with backpressure.
	if (body != null && typeof (body as any).pipe === 'function') {
		streamResponse(res, status, headers, body as any, signal);
		return;
	}

	res.cork(() => {
		res.writeStatus(statusText(status));
		writeHeaders(res, headers);
		if (body == null) res.end();
		else res.end(body as any); // string | Buffer | Uint8Array
	});
}

/**
 * Stream a Node Readable to the uWS response with backpressure. uWS only flushes the status/headers
 * on the first body write, so for text/event-stream (SSE) — where the client must see the stream
 * open before any event — we emit a spec-valid comment line to force the flush. Client disconnect
 * (via `signal`) or a source error destroys the source and stops writing (writing to an aborted uWS
 * response is invalid).
 */
function streamResponse(
	res: UwsResponse,
	status: number,
	headers: Headers,
	source: { on: Function; once: Function; pause: Function; resume: Function; destroy?: Function },
	signal?: AbortSignal
): void {
	let finished = false;
	const finish = (endResponse: boolean) => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener('abort', onAbort);
		if (endResponse) res.cork(() => res.end());
	};
	function onAbort() {
		if (finished) return;
		finished = true;
		source.destroy?.();
	}
	if (signal?.aborted) return onAbort();
	signal?.addEventListener('abort', onAbort, { once: true });

	const isSse = String(headers.get('content-type') ?? '').includes('text/event-stream');
	res.cork(() => {
		res.writeStatus(statusText(status));
		writeHeaders(res, headers);
		if (isSse) res.write(':\n\n'); // SSE comment: flushes headers immediately, ignored by clients
	});

	source.on('data', (chunk: Buffer) => {
		if (finished) return;
		let ok = true;
		res.cork(() => {
			ok = res.write(chunk);
		});
		if (!ok) {
			// Backpressure: pause the source until uWS drains, then resume.
			source.pause();
			res.onWritable(() => {
				if (!finished) source.resume();
				return true;
			});
		}
	});
	source.once('end', () => finish(true));
	source.once('error', () => finish(true)); // headers already sent; just terminate the response
}

// Normalize uWS's remote-address text (raw IPv6 form, IPv4-mapped for v4 peers) to a readable IP.
function normalizeAddress(text: string): string {
	const mapped = /^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(text);
	if (mapped) {
		const hi = parseInt(mapped[1], 16);
		const lo = parseInt(mapped[2], 16);
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	return text;
}

function registerWsBehavior(
	app: UwsApp,
	wsHandler: (ws: UwsWebSocket, upgrade: UwsUpgrade) => void,
	maxPayload: number
): void {
	app.ws('/*', {
		maxPayload,
		// Capture the upgrade request synchronously (uWS's HttpRequest is only valid here) and upgrade.
		// Auth runs after open() in the ws chain, matching the Node path (which upgrades then authorizes).
		upgrade: (res: UwsResponse, req: UwsRequestRaw, context: unknown) => {
			const query = req.getQuery();
			const url = req.getUrl() + (query ? '?' + query : '');
			const headers: Record<string, string | string[]> = {};
			req.forEach((k: string, v: string) => {
				const existing = headers[k];
				if (existing === undefined) headers[k] = v;
				else if (Array.isArray(existing)) existing.push(v);
				else headers[k] = [existing, v];
			});
			const ip = normalizeAddress(Buffer.from(res.getRemoteAddressAsText()).toString());
			const upgradeData: UwsUpgrade = { url, headers, ip };
			res.upgrade(
				upgradeData,
				req.getHeader('sec-websocket-key'),
				req.getHeader('sec-websocket-protocol'),
				req.getHeader('sec-websocket-extensions'),
				context
			);
		},
		open: (ws: any) => {
			const data = ws.getUserData() as UwsUpgrade;
			const adapter = new UwsWebSocket(ws);
			adapter._socket.remoteAddress = data.ip;
			data.adapter = adapter;
			wsHandler(adapter, data);
		},
		message: (ws: any, message: ArrayBuffer, isBinary: boolean) =>
			ws.getUserData().adapter?._message(message, isBinary),
		drain: (ws: any) => ws.getUserData().adapter?._drain(),
		close: (ws: any, code: number, message: ArrayBuffer) => ws.getUserData().adapter?._closed(code, message),
	});
}

/**
 * A backpressure-aware stand-in for the `ws` library's underlying socket. Harper's WS consumers read
 * `remoteAddress` and gate on `writableNeedDrain` / `'drain'`; uWS surfaces those via getBufferedAmount()
 * and the behavior's drain callback.
 */
class UwsSocketShim extends EventEmitter {
	remoteAddress = '';
	#raw: any;
	constructor(raw: any) {
		super();
		this.#raw = raw;
	}
	get writableNeedDrain(): boolean {
		try {
			return this.#raw.getBufferedAmount() > 0;
		} catch {
			return false;
		}
	}
}

/**
 * Adapts a uWS WebSocket to the subset of the `ws` library's WebSocket interface that Harper's WS
 * consumers use (MQTT-over-WS in server/mqtt.ts, subscriptions in server/REST.ts): send/close/
 * terminate/ping, the 'message'/'close'/'error' events, `_socket`, and `readyState`. This lets the
 * existing websocket chain run unchanged on the uWS transport.
 */
export class UwsWebSocket extends EventEmitter {
	#raw: any;
	#open = true;
	#closeEmitted = false;
	public _socket: UwsSocketShim;
	public binaryType = 'nodebuffer';

	constructor(raw: any) {
		super();
		this.#raw = raw;
		this._socket = new UwsSocketShim(raw);
	}
	get readyState(): number {
		return this.#open ? 1 /* OPEN */ : 3 /* CLOSED */;
	}
	send(data: any, optionsOrCb?: any, maybeCb?: any): void {
		// ws-library signature is send(data[, options][, callback]); tolerate either arrangement.
		const cb: ((error?: Error) => void) | undefined =
			typeof optionsOrCb === 'function' ? optionsOrCb : typeof maybeCb === 'function' ? maybeCb : undefined;
		if (!this.#open) {
			cb?.(new Error('WebSocket is not open'));
			return;
		}
		try {
			const isBinary = typeof data !== 'string';
			const payload = isBinary && !Buffer.isBuffer(data) && !(data instanceof Uint8Array) ? Buffer.from(data) : data;
			this.#raw.send(payload, isBinary);
			cb?.();
		} catch (error) {
			cb?.(error as Error);
		}
	}
	close(code?: number, reason?: string): void {
		if (!this.#open) return;
		this.#open = false;
		try {
			if (code != null) this.#raw.end(code, reason);
			else this.#raw.end();
		} catch {
			/* already closed by the peer */
		}
	}
	terminate(): void {
		if (!this.#open) return;
		this.#open = false;
		try {
			this.#raw.close();
		} catch {
			/* already closed */
		}
	}
	ping(): void {
		try {
			this.#raw.ping();
		} catch {
			/* not open */
		}
	}
	// uWS behavior hooks:
	_message(message: ArrayBuffer, isBinary: boolean): void {
		// Copy out of uWS's buffer — it's neutered once this callback returns and consumers read async.
		this.emit('message', Buffer.from(new Uint8Array(message)), isBinary);
	}
	_drain(): void {
		this._socket.emit('drain');
	}
	_closed(code: number, message: ArrayBuffer): void {
		this.#open = false;
		if (this.#closeEmitted) return;
		this.#closeEmitted = true;
		this.emit('close', code, message ? Buffer.from(new Uint8Array(message)) : Buffer.alloc(0));
	}
}
