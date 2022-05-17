'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
let installer;
if (is_compiled) {
	require('bytenode');
	installer = require('../dependencies/installNATSServer.jsc');
} else {
	installer = require('../server/nats/utility/installNATSServer');
}

(async () => {
	try {
		await installer();
	} catch (err) {
		console.error(err);
	}
})();
