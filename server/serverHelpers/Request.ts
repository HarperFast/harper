import type { IncomingMessage as NodeIncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { Headers as ResponseHeaders } from './Headers.ts';

export const isBun = typeof globalThis.Bun !== 'undefined';

// Some request compatible type-ing. We can handle both HTTP and HTTPS requests and the server is augmented.
interface IncomingMessage extends NodeIncomingMessage {
	authority?: string;
	socket: (Socket | TLSSocket) & {
		authorized?: boolean; // only for TLSSocket
		encrypted?: boolean; // only for TLSSocket
		getPeerCertificate?: (detailed?: boolean) => any; // only for TLSSocket
		server?: {
			mtlsConfig?: any;
		};
	};
}

/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
export class Request {
	#body: RequestBody | undefined;
	#peerCertificate: any;
	#abortController = new AbortController();
	public _nodeRequest: IncomingMessage;
	public _nodeResponse?: NodeServerResponse;
	public method: string;
	public url: string;
	public headers: RequestHeaders;
	public requestId?: number;
	public isOperationsServer?: boolean;
	public handlerPath?: string;
	public __harperdbRequestUpgraded?: boolean;
	public __harperRequestUpgraded?: boolean;
	public createdResource?: boolean;
	public newLocation?: string;
	public isWebSocket?: boolean;
	public user?: any; // User object can be attached during authentication
	public response: {
		status?: number;
		headers: ResponseHeaders;
	};
	public responseHeaders?: any;
	public expiresAt?: number;
	public onlyIfCached?: boolean;
	public noCache?: boolean;
	public noCacheStore?: boolean;
	public staleIfError?: boolean;
	public mustRevalidate?: boolean;
	public replicatedConfirmation?: number;
	public replicateTo?: any;
	public replicateFrom?: any;
	public data?: any;
	public authorize?: boolean;
	public lastModified?: number;
	public lastRefreshed?: number;

	constructor(nodeRequest: IncomingMessage, nodeResponse?: NodeServerResponse) {
		this.method = nodeRequest.method;
		const url = nodeRequest.url;
		this._nodeRequest = nodeRequest;
		this._nodeResponse = nodeResponse;
		this.url = url;
		this.headers = new RequestHeaders(nodeRequest.headers);
		this.__harperRequestUpgraded = false;
		// Abort the request's signal on premature client disconnect. nodeResponse 'close'
		// also fires on clean completion; the writableFinished guard restricts to disconnect.
		if (typeof nodeResponse?.on === 'function') {
			nodeResponse.on('close', () => {
				if (!nodeResponse.writableFinished) this.#abortController.abort();
			});
		} else if (typeof nodeRequest.socket?.once === 'function') {
			// No response on this Request — typically the WebSocket-upgrade path
			// (http.ts creates the Request before the ws library takes over). The TCP
			// socket close is the fallback abort trigger; REST.ts's ws.on('close') hook
			// also calls _abort() and is the primary signal in the WS case. The two
			// are redundant by design (idempotent abort) so any future single-arg
			// caller still gets disconnect semantics without relying on the WS layer.
			nodeRequest.socket.once('close', () => this.#abortController.abort());
		}
	}
	get signal(): AbortSignal {
		return this.#abortController.signal;
	}
	/**
	 * Abort this request's signal. Used by transports (e.g. WebSocket) that need to
	 * signal client-side cancellation independently of the Node response lifecycle.
	 */
	_abort(): void {
		this.#abortController.abort();
	}
	get absoluteURL() {
		return this.protocol + '://' + this.host + this.url;
	}
	get pathname() {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) return this.url.slice(0, queryStart);
		return this.url;
	}
	set pathname(pathname) {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) this.url = pathname + this.url.slice(queryStart);
		else this.url = pathname;
	}
	get protocol() {
		return this._nodeRequest.socket.encrypted ? 'https' : 'http';
	}
	get ip() {
		return this._nodeRequest.socket.remoteAddress;
	}
	get authorized() {
		return this._nodeRequest.socket.authorized;
	}
	get peerCertificate() {
		// Cache the certificate to avoid repeated parsing overhead
		// getPeerCertificate() calls translatePeerCertificate which parses
		// the raw certificate data each time (via handle.getPeerCertificate() -> SSL_get_peer_certificate)
		// This issue persists in Node.js v24 - https://github.com/nodejs/node/blob/v24.x/lib/_tls_wrap.js#L1117
		if (this.#peerCertificate === undefined) {
			// Pass true to include the full certificate chain with issuerCertificate properties
			// This is required for OCSP verification which needs both the peer cert and its issuer
			this.#peerCertificate = this._nodeRequest.socket.getPeerCertificate?.(true) || null;
		}
		return this.#peerCertificate;
	}
	get mtlsConfig() {
		return this._nodeRequest.socket.server.mtlsConfig;
	}
	get body() {
		return this.#body || (this.#body = new RequestBody(this._nodeRequest));
	}
	get host() {
		return this._nodeRequest.authority || this._nodeRequest.headers.host;
	}
	get hostname() {
		return this._nodeRequest.headers.host;
	}
	get httpVersion() {
		return this._nodeRequest.httpVersion;
	}
	get isAborted() {
		return this.#abortController.signal.aborted;
	}
	// Expose node request for cases that need direct access (e.g., replication)
	get nodeRequest() {
		return this._nodeRequest;
	}
	/**
	 * Invokes `handler` with a Node.js IncomingMessage/ServerResponse pair that adapts this Request
	 * into the Node HTTP API, and returns a Promise that resolves to a Harper Response once the handler
	 * writes its status and headers. Useful for integrating third-party Node middleware that expects
	 * the native node http request/response objects.
	 *
	 * The IncomingMessage mirrors the current Request state (method, url, headers may have been modified
	 * by middleware) while delegating body reading to the underlying stream. The ServerResponse captures
	 * status, headers, and body, resolving the returned promise as soon as headers are available with a
	 * streaming body that can be piped back through the Harper middleware chain.
	 *
	 * **Important:** The resolved `body` PassThrough must have an `error` listener attached (or be piped
	 * to a destination that handles errors) before it is consumed. If the underlying connection is reset
	 * after headers are sent, the body stream is destroyed with an error — without a listener, Node.js
	 * will throw an uncaught exception.
	 *
	 * Example:
	 *   server.http((request, next) =>
	 *     request.withNodeAdapter((req, res) => someNodeMiddleware(req, res))
	 *   );
	 */
	withNodeAdapter(
		handler: (request: NodeIncomingMessage, response: NodeServerResponse) => void | Promise<void>
	): Promise<{ status: number; headers: ResponseHeaders; body: PassThrough }> {
		// Flat headers object matching IncomingMessage.headers format (lowercase keys)
		const reqHeaders: Record<string, string | string[]> = Object.create(null);
		for (const [key, value] of this.headers) {
			reqHeaders[key.toLowerCase()] = value;
		}

		// Proxy the underlying IncomingMessage so body streaming works, but expose
		// the current Request's (possibly middleware-mutated) method/url/headers.
		const self = this;
		const nodeReq = new Proxy(this._nodeRequest, {
			get(target, prop, receiver) {
				if (prop === 'method') return self.method;
				if (prop === 'url') return self.url;
				if (prop === 'headers') return reqHeaders;
				return Reflect.get(target, prop, receiver);
			},
		}) as NodeIncomingMessage;

		let resolveResponse!: (value: { status: number; headers: ResponseHeaders; body: PassThrough }) => void;
		let rejectResponse!: (reason: unknown) => void;
		const response = new Promise<{ status: number; headers: ResponseHeaders; body: PassThrough }>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});

		const responseBody = new PassThrough();
		const capturedHeaders = new ResponseHeaders();
		let headersFlushed = false;
		let nodeRes: ReturnType<typeof Object.assign> & NodeServerResponse;

		const flushHeaders = () => {
			if (!headersFlushed) {
				headersFlushed = true;
				nodeRes.headersSent = true;
				resolveResponse({ status: nodeRes.statusCode as number, headers: capturedHeaders, body: responseBody });
			}
		};

		const applyHeaders = (hdrs: object | unknown[]) => {
			if (Array.isArray(hdrs)) {
				if (hdrs.length > 0 && Array.isArray(hdrs[0])) {
					for (const [name, value] of hdrs as [string, string][]) capturedHeaders.set(name, value);
				} else {
					for (let i = 0; i < hdrs.length; i += 2) capturedHeaders.set(hdrs[i] as string, hdrs[i + 1] as string);
				}
			} else {
				for (const [k, v] of Object.entries(hdrs)) capturedHeaders.set(k, v as string);
			}
		};

		nodeRes = Object.assign(new EventEmitter(), {
			statusCode: 200 as number,
			statusMessage: '',
			headersSent: false,
			writable: true,
			writableEnded: false,
			writableFinished: false,
			socket: this._nodeRequest.socket,

			setHeader(name: string, value: string | number | string[]) {
				if (Array.isArray(value)) {
					// Use set() for first value (overwrites any existing entry) then append() for
					// the rest so multiple values — critical for Set-Cookie — are preserved as an
					// array rather than collapsed into a single comma-joined string.
					if (value.length > 0) {
						capturedHeaders.set(name, String(value[0]));
						for (let i = 1; i < value.length; i++) capturedHeaders.append(name, String(value[i]));
					}
				} else {
					capturedHeaders.set(name, String(value));
				}
				return nodeRes;
			},
			getHeader(name: string) {
				return capturedHeaders.get(name);
			},
			getHeaders() {
				return Object.fromEntries(capturedHeaders);
			},
			hasHeader(name: string) {
				return capturedHeaders.has(name);
			},
			removeHeader(name: string) {
				capturedHeaders.delete(name);
			},
			flushHeaders() {
				flushHeaders();
			},
			writeHead(statusCode: number, statusMessageOrHeaders?: string | object, maybeHeaders?: object) {
				if (headersFlushed) return nodeRes;
				nodeRes.statusCode = statusCode;
				const hdrs = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
				if (hdrs) applyHeaders(hdrs as object | unknown[]);
				flushHeaders();
				return nodeRes;
			},
			write(
				chunk: unknown,
				encoding?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void
			) {
				flushHeaders();
				if (typeof encoding === 'function') return responseBody.write(chunk as any, encoding);
				return responseBody.write(chunk as any, encoding, callback);
			},
			end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) {
				flushHeaders();
				nodeRes.writableEnded = true;
				if (typeof chunk === 'function') responseBody.end(chunk as () => void);
				else if (typeof encoding === 'function') responseBody.end(chunk as any, encoding);
				else responseBody.end(chunk as any, encoding, callback);
				return nodeRes;
			},
			destroy(error?: Error) {
				if (!headersFlushed) {
					if (error) rejectResponse(error);
					else rejectResponse(new Error('Response destroyed before headers were sent'));
					// The error has been forwarded to the response promise; suppress the
					// PassThrough 'error' event for this one destroy call so Node doesn't
					// throw due to having no other listeners.
					responseBody.once('error', () => {});
				}
				responseBody.destroy(error);
				return nodeRes;
			},
		}) as unknown as NodeServerResponse;

		responseBody.on('finish', () => {
			nodeRes.writableFinished = true;
			(nodeRes as unknown as EventEmitter).emit('finish');
		});
		responseBody.on('drain', () => {
			(nodeRes as unknown as EventEmitter).emit('drain');
		});
		responseBody.on('close', () => {
			(nodeRes as unknown as EventEmitter).emit('close');
		});

		const handlerResult = handler(nodeReq, nodeRes);
		if (handlerResult != null && typeof (handlerResult as unknown as Promise<void>).then === 'function') {
			(handlerResult as unknown as Promise<void>).catch((err: unknown) => {
				if (!headersFlushed) rejectResponse(err);
			});
		}
		return response;
	}
	sendEarlyHints(link: string, headers: Record<string, any> = {}) {
		headers.link = link;
		this._nodeResponse.writeEarlyHints(headers);
	}
}

/**
 * Bun-compatible Request adapter. Wraps a Web Fetch API Request (from Bun.serve's fetch handler)
 * to present the same interface as the Node.js-based Request class.
 */
export class BunRequest {
	#body: BunRequestBody | undefined;
	#ip: string | undefined;
	#isSecure: boolean;
	public _webRequest: globalThis.Request;
	public _bunServer: any;
	// Provide _nodeRequest as null for code that checks it; _nodeResponse is not applicable
	public _nodeRequest: any = null;
	public _nodeResponse: any = null;
	public method: string;
	public url: string;
	public headers: RequestHeaders;
	public isWebSocket?: boolean;
	public user?: any;
	public response: {
		status?: number;
		headers: ResponseHeaders;
	};
	public __harperRequestUpgraded: boolean;

	constructor(webRequest: globalThis.Request, bunServer: any, isSecure: boolean) {
		this._webRequest = webRequest;
		this._bunServer = bunServer;
		this.#isSecure = isSecure;
		this.method = webRequest.method;
		// Web Request.url is a full URL; extract the path + query to match Node's IncomingMessage.url
		const fullUrl = webRequest.url;
		const protocolEnd = fullUrl.indexOf('//');
		const pathStart = fullUrl.indexOf('/', protocolEnd + 2);
		this.url = pathStart >= 0 ? fullUrl.slice(pathStart) : '/';
		// Convert Web Headers to plain object for our RequestHeaders wrapper
		const headersObj: Record<string, string> = {};
		webRequest.headers.forEach((value, key) => {
			headersObj[key] = value;
		});
		this.headers = new RequestHeaders(headersObj);
		this.__harperRequestUpgraded = false;
	}
	get absoluteURL() {
		return this._webRequest.url;
	}
	get pathname() {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) return this.url.slice(0, queryStart);
		return this.url;
	}
	set pathname(pathname) {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) this.url = pathname + this.url.slice(queryStart);
		else this.url = pathname;
	}
	get protocol() {
		return this.#isSecure ? 'https' : 'http';
	}
	get ip() {
		if (this.#ip === undefined) {
			const addr = this._bunServer?.requestIP?.(this._webRequest);
			this.#ip = addr?.address || '';
		}
		return this.#ip;
	}
	get authorized() {
		// TLS client authorization is not directly accessible via Bun.serve()
		return undefined;
	}
	get peerCertificate() {
		// Peer certificates are not accessible via Bun.serve()
		return null;
	}
	get mtlsConfig() {
		return undefined;
	}
	get body() {
		return this.#body || (this.#body = new BunRequestBody(this._webRequest));
	}
	get host() {
		return this.headers.get('host') as string;
	}
	get hostname() {
		return this.headers.get('host') as string;
	}
	get httpVersion() {
		return '1.1';
	}
	get isAborted() {
		return this._webRequest.signal?.aborted ?? false;
	}
	get signal(): AbortSignal {
		// Bun.serve() aborts this signal on HTTP client disconnect. Behavior on
		// WebSocket-upgrade is implementation-defined; if the WS path needs
		// guaranteed abort-on-close under Bun, wire it through Bun's ws close
		// handler with a Bun-side AbortController, similar to REST.ts on Node.
		return this._webRequest.signal;
	}
	_abort(): void {
		// On Bun, abort is driven by the underlying Web Request's signal; no-op for parity with Node path.
	}
	get nodeRequest() {
		return null;
	}
	sendEarlyHints(_link: string, _headers: Record<string, any> = {}) {
		// Early hints not supported on Bun
	}
}

class RequestBody {
	#nodeRequest: IncomingMessage;
	constructor(nodeRequest: IncomingMessage) {
		this.#nodeRequest = nodeRequest;
	}
	on(event: string, listener: (...args: any[]) => void) {
		this.#nodeRequest.on(event, listener);
		return this;
	}
	pipe(destination: any, options?: any) {
		return this.#nodeRequest.pipe(destination, options);
	}
	// Delegate async iteration to the underlying request, which is natively
	// async-iterable. Without this, `for await (const chunk of request.body)`
	// throws `TypeError: body is not async iterable` (#1317).
	[Symbol.asyncIterator]() {
		return this.#nodeRequest[Symbol.asyncIterator]();
	}
}

class BunRequestBody {
	#webRequest: any;
	#readable: any; // lazily created Readable stream
	constructor(webRequest: any) {
		this.#webRequest = webRequest;
	}
	#getReadable() {
		if (!this.#readable) {
			const body = this.#webRequest.body;
			if (body) {
				this.#readable = Readable.fromWeb(body as any);
			} else {
				// No body — create an empty readable that immediately ends
				this.#readable = new Readable({
					read() {
						this.push(null);
					},
				});
			}
		}
		return this.#readable;
	}
	on(event: string, listener: (...args: any[]) => void) {
		this.#getReadable().on(event, listener);
		return this;
	}
	pipe(destination: any, options?: any) {
		return this.#getReadable().pipe(destination, options);
	}
	// Mirror RequestBody: delegate async iteration to the underlying Readable
	// (natively async-iterable) so `for await` consumers work on Bun too (#1317).
	[Symbol.asyncIterator]() {
		return this.#getReadable()[Symbol.asyncIterator]();
	}
}

class RequestHeaders {
	public asObject: Record<string, string | string[]>;

	constructor(asObject: Record<string, string | string[]>) {
		this.asObject = asObject;
	}

	set(name: string, value: string | string[]) {
		this.asObject[name.toLowerCase()] = value;
	}
	get(name: string): string | string[] | undefined {
		return this.asObject[name.toLowerCase()];
	}
	has(name: string): boolean {
		return Object.prototype.hasOwnProperty.call(this.asObject, name.toLowerCase());
	}
	[Symbol.iterator]() {
		return Object.entries(this.asObject)[Symbol.iterator]();
	}
	keys() {
		return Object.keys(this.asObject);
	}
	values() {
		return Object.values(this.asObject);
	}
	delete(name: string) {
		delete this.asObject[name.toLowerCase()];
	}
	forEach(callback: (value: string | string[], key: string, headers: RequestHeaders) => void) {
		for (const [key, value] of this) {
			callback(value, key, this);
		}
	}
}
