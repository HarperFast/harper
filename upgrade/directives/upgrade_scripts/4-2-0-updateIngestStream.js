'use strict';

const env_mgr = require('../../../utility/environment/environmentManager');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const hdb_utils = require('../../../utility/common_utils');
const nats_terms = require('../../../server/nats/utility/natsTerms');
const hdb_terms = require('../../../utility/hdbTerms');
const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');

module.exports = updateIngestStream;

async function updateIngestStream() {
	const stream_path = path.join(
		env_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH),
		'clustering',
		'leaf',
		'jetstream',
		'HDB',
		'streams',
		nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name
	);
	const backup_stream_path = path.join(
		env_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH),
		'backup',
		nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name
	);

	if (!(await fs.pathExists(stream_path))) return;
	const stream_meta = await fs.readJson(path.join(stream_path, 'meta.inf'));

	let nr = await nats_utils.getNATSReferences();
	const old_ingest_info = await nr.jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);

	let sources;
	if (!hdb_utils.isEmptyOrZeroLength(old_ingest_info.sources)) {
		sources = _.cloneDeep(old_ingest_info.sources);
	}
	await nats_utils.closeConnection();
	await fs.move(stream_path, backup_stream_path);

	await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
	// If no sources existed no need to update anything.
	if (sources.length === 0) return;

	const ingest_info = await nr.jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
	console.log(ingest_info);
	await nats_utils.closeConnection();
}

updateIngestStream().then(() => {});
