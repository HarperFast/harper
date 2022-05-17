'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
let nats_reply_service;
if (is_compiled) {
	require('bytenode');
	nats_reply_service = require('../server/nats/natsReplyService.jsc');
} else {
	nats_reply_service = require('../server/nats/natsReplyService');
}

(async () => {
	try {
		await nats_reply_service();
	} catch (err) {
		console.error('Error launching Nats reply service.');
		console.error(err);
	}
})();
