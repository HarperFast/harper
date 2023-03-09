'use strict';

const env_mgr = require('../environment/environmentManager');
const hdb_logger = require('./harper_logger');
const { CONFIG_PARAMS } = require('../hdbTerms');

const LOG_ROTATE_INTERVAL = 60000;
const INT_SIZE_UNDEFINED_MSG =
	"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml";
const PATH_UNDEFINED_MSG =
	"'logging.rotation.path' is undefined, to enable logging rotation set this value in harperdb-config.yaml";

module.exports = logRotator;

async function logRotator() {
	const log_path = env_mgr.get(CONFIG_PARAMS.LOGGING_ROOT);
	const max_size = env_mgr.get(CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE);
	const interval = env_mgr.get(CONFIG_PARAMS.LOGGING_ROTATION_INTERVAL);
	if (!max_size && !interval) {
		hdb_logger.error(INT_SIZE_UNDEFINED_MSG);
		return;
	}

	const rotated_log_path = env_mgr.get(CONFIG_PARAMS.LOGGING_ROTATION_PATH);
	if (!rotated_log_path) {
		hdb_logger.error(PATH_UNDEFINED_MSG);
		return;
	}

	setInterval(() => {
		if (m) {
		}
	}, LOG_ROTATE_INTERVAL).unref();
}
