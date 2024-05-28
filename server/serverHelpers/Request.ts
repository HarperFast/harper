import { platform } from 'os';
/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
export class Request {
	#body;
	constructor(node_request, node_response) {
		this.method = node_request.method;
		const url = node_request.url;
		this._nodeRequest = node_request;
		this._nodeResponse = node_response;
		this.url = url;
		this.headers = new Headers(node_request.headers);
	}
	get absoluteURL() {
		return this.protocol + '://' + this.host + this.url;
	}
	get pathname() {
		const query_start = this.url.indexOf('?');
		if (query_start > -1) return this.url.slice(0, query_start);
		return this.url;
	}
	set pathname(pathname) {
		const query_start = this.url.indexOf('?');
		if (query_start > -1) this.url = pathname + this.url.slice(query_start);
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
		return this._nodeRequest.socket.getPeerCertificate?.();
	}
	get peerX509Certificate() {
		return this._nodeRequest.socket.getPeerX509Certificate?.();
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
	get isAborted() {
		// TODO: implement this
		return false;
	}
}
class RequestBody {
	#node_request;
	constructor(node_request) {
		this.#node_request = node_request;
	}
	on(event, listener) {
		this.#node_request.on(event, listener);
		return this;
	}
	pipe(destination, options) {
		return this.#node_request.pipe(destination, options);
	}
}

class Headers {
	constructor(protected asObject) {}

	set(name, value) {
		this.asObject[name.toLowerCase()] = value;
	}
	get(name) {
		return this.asObject[name.toLowerCase()];
	}
	has(name) {
		return this.asObject.hasOwnProperty(name.toLowerCase());
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
	forEach(callback) {
		for (const [key, value] of this) {
			callback(value, key, this);
		}
	}
}
export let createReuseportFd;
if (platform() != 'win32') createReuseportFd = require('node-unix-socket').createReuseportFd;
