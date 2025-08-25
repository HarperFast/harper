'use strict';

const natsIngestService = require('../server/nats/natsIngestService.js');

(async () => {
	try {
		await natsIngestService.initialize();
	} catch (err) {
		console.error('Error launching Nats ingest service.');
		console.error(err);
	}
})();
