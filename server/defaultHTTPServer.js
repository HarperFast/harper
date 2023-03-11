'use strict';
const { createServer } = require('http');
const http_server = require('../threads/thread-http-server');

module.exports = {
	start,
	onRequest,
};
let listeners = [];
function onRequest(listener) {
	listeners.push(listener);
}
const TRUE_COMPARE_VAL = 'TRUE';
let server = undefined;

// TODO: Make the thread-http-server part of the plugin and go through a public API for listening to sockets
function start(options) {
	/*options.keepAlive = true;
	let server = createServer(options, async (request, response) => {
		for (let i = 0, l = listeners.length; i < l; i++) {
			let listener = listeners[i];
			let result = listener(request, response);
			if (result.then) result = await result;
			if (result) return;
		}
	});
	http_server.registerServer(server, options.port);*/
}
