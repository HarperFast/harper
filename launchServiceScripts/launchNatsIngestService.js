'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
let nats_ingest_service;
if (is_compiled) {
	require('bytenode');
	nats_ingest_service = require('../server/nats/natsIngestService.jsc');
} else {
	nats_ingest_service = require('../server/nats/natsIngestService');
}

(async () => {
	try {
		await nats_ingest_service.initialize();
		await nats_ingest_service.workQueueListener();
	} catch (err) {
		console.error('Error launching Nats ingest service.');
		console.error(err);
	}
})();
