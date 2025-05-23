import { platform } from 'os';
/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
export class Request {
	#body;
	constructor(nodeRequest, nodeResponse) {
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
		return this._nodeRequest.socket.getPeerCertificate();
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
	get httpVersion() {
		return this._nodeRequest.httpVersion;
	}
	get isAborted() {
		// TODO: implement this
		return false;
	}
	sendEarlyHints(link: string, headers = {}) {
		headers.link = link;
		this._nodeResponse.writeEarlyHints(headers);
	}
}
class RequestBody {
	#nodeRequest;
	constructor(nodeRequest) {
		this.#nodeRequest = nodeRequest;
	}
	on(event, listener) {
		this.#nodeRequest.on(event, listener);
		return this;
	}
	pipe(destination, options) {
		return this.#nodeRequest.pipe(destination, options);
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
	delete(name) {
		delete this.asObject[name.toLowerCase()];
	}
	forEach(callback) {
		for (const [key, value] of this) {
			callback(value, key, this);
		}
	}
}
export let createReuseportFd;
if (platform() != 'win32') createReuseportFd = require('node-unix-socket').createReuseportFd;
