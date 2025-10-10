import { platform } from 'os';
import type { IncomingMessage as NodeIncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';

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
	private _nodeRequest: IncomingMessage;
	private _nodeResponse: NodeServerResponse;
	public method: string;
	public url: string;
	public headers: Headers;
	public isWebSocket?: boolean;
	public user?: any; // User object can be attached during authentication

	constructor(nodeRequest: IncomingMessage, nodeResponse: NodeServerResponse) {
		this.method = nodeRequest.method;
		const url = nodeRequest.url;
		this._nodeRequest = nodeRequest;
		this._nodeResponse = nodeResponse;
		this.url = url;
		this.headers = new Headers(nodeRequest.headers);
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
