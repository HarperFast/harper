'use strict';

const natsReplyService = require('../server/nats/natsReplyService.js');

(async () => {
	try {
		await natsReplyService();
	} catch (err) {
		console.error('Error launching Nats reply service.');
		console.error(err);
	}
})();
