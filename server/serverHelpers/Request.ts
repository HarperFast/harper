import { platform } from 'os';
import type { IncomingMessage as NodeIncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Headers as ResponseHeaders } from './Headers.ts';

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
	public _nodeRequest: IncomingMessage;
	public _nodeResponse?: NodeServerResponse;
	public method: string;
	public url: string;
	public headers: Headers;
	public isWebSocket?: boolean;
	public user?: any; // User object can be attached during authentication
	public response: {
		status?: number;
		headers: ResponseHeaders;
	};
	public __harperRequestUpgraded: boolean;

	constructor(nodeRequest: IncomingMessage, nodeResponse: NodeServerResponse) {
		this.method = nodeRequest.method;
		const url = nodeRequest.url;
		this._nodeRequest = nodeRequest;
		this._nodeResponse = nodeResponse;
		this.url = url;
		this.headers = new Headers(nodeRequest.headers);
		this.__harperRequestUpgraded = false;
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
		// TODO: implement this
		return false;
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
	 * Example:
	 *   server.http((request, next) =>
	 *     request.sendNodeRequestResponse((req, res) => someNodeMiddleware(req, res))
	 *   );
	 */
	sendNodeRequestResponse(
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
				if (typeof encoding === 'function') responseBody.end(chunk as any, encoding);
				else responseBody.end(chunk as any, encoding, callback);
				return nodeRes;
			},
			destroy(error?: Error) {
				if (!headersFlushed) {
					if (error) rejectResponse(error);
					else rejectResponse(new Error('Response destroyed before headers were sent'));
				}
				responseBody.destroy(error);
				return nodeRes;
			},
		}) as unknown as NodeServerResponse;

		responseBody.on('finish', () => {
			nodeRes.writableFinished = true;
			(nodeRes as unknown as EventEmitter).emit('finish');
		});
		responseBody.on('close', () => {
			(nodeRes as unknown as EventEmitter).emit('close');
		});
		// Prevent uncaught 'error' events when destroy(err) is called; errors before headers
		// are propagated via the response promise rejection instead.
		responseBody.on('error', () => {});

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
}

class Headers {
	private asObject: Record<string, string | string[]>;

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
	forEach(callback: (value: string | string[], key: string, headers: Headers) => void) {
		for (const [key, value] of this) {
			callback(value, key, this);
		}
	}
}
export let createReuseportFd: any;
if (platform() != 'win32') createReuseportFd = require('node-unix-socket').createReuseportFd;
