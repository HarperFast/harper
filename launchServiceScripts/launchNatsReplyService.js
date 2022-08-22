'use strict';

const nats_reply_service = require('../server/nats/natsReplyService');

(async () => {
	try {
		await nats_reply_service();
	} catch (err) {
		console.error('Error launching Nats reply service.');
		console.error(err);
	}
})();
