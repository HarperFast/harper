'use strict';

const { registerServer } = require('../threads/thread-http-server');

module.exports = {
	start,
};
const TRUE_COMPARE_VAL = 'TRUE';
let server = undefined;

// TODO: Make the thread-http-server part of the plugin and go through a public API for listening to sockets
function start(options) {
	return {
		customFunctionHandler(server) {
			return registerServer(options.port, server);
		},
	};
}
