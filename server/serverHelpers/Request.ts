export const node_request_key = Symbol('node request');
/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
export class Request {
	[node_request_key];
	#body;
	constructor(node_request) {
		this.method = node_request.method;
		const url = node_request.url;
		this[node_request_key] = node_request;
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
		return this[node_request_key].socket.encrypted ? 'https' : 'http';
	}
	get ip() {
		return this[node_request_key].socket.remoteAddress;
	}
	get body() {
		return this.#body || (this.#body = new RequestBody(this[node_request_key]));
	}
	get host() {
		return this[node_request_key].authority || this[node_request_key].headers.host;
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
}

class Headers {
	constructor(protected asObject) {}

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
