'use strict';

const nats_ingest_service = require('../server/nats/natsIngestService');

(async () => {
	try {
		await nats_ingest_service.initialize();
	} catch (err) {
		console.error('Error launching Nats ingest service.');
		console.error(err);
	}
})();
