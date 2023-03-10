'use strict';

const { promises: fs_prom, createReadStream, createWriteStream } = require('fs');
const { createGzip } = require('zlib');
const { promisify } = require('util');
const { pipeline } = require('stream');
const pipe = promisify(pipeline);
const path = require('path');
const env_mgr = require('../environment/environmentManager');
env_mgr.initSync();
const hdb_logger = require('./harper_logger');
const { CONFIG_PARAMS, ITC_EVENT_TYPES } = require('../hdbTerms');
const { onMessageFromWorkers } = require('../../server/threads/manageThreads');

const LOG_ROTATE_INTERVAL = 60000;
const INT_SIZE_UNDEFINED_MSG =
	"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml";
const PATH_UNDEFINED_MSG =
	"'logging.rotation.path' is undefined, to enable logging rotation set this value in harperdb-config.yaml";

let last_rotation_time;
let set_interval_id;

module.exports = logRotator;

// On restart event check to see if rotator should be enabled
onMessageFromWorkers((message) => {
	if (message.type === ITC_EVENT_TYPES.RESTART) {
		env_mgr.initSync(true);
		clearInterval(set_interval_id);
		if (env_mgr.get(CONFIG_PARAMS.LOGGING_ROTATION_ENABLED)) logRotator();
	}
});

/**
 * Rotates hdb.log using an interval and/or maxSize param.
 * Uses an unref setInterval to periodically check time passed since rotation and size of log file.
 * @returns {Promise<void>}
 */
async function logRotator() {
	try {
		const log_path = hdb_logger.getLogFilePath();
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

		let max_bytes;
		if (max_size) {
			const unit = max_size.slice(-1);
			const size = max_size.slice(0, -1);
			if (unit === 'G') max_bytes = size * 1000000000;
			else if (unit === 'M') max_bytes = size * 1000000;
			else max_bytes = size * 1000;
		}

		let max_interval;
		if (interval) {
			const unit = interval.slice(-1);
			const value = interval.slice(0, -1);
			if (unit === 'D') max_interval = value * 1440;
			else if (unit === 'H') max_interval = value * 60;
			else max_interval = value;
		}

		last_rotation_time = Date.now() / 60000;
		hdb_logger.trace('Log rotate enabled, maxSize:', max_size, 'interval:', interval);
		set_interval_id = setInterval(async () => {
			if (max_bytes) {
				let file_stats;
				file_stats = await fs_prom.stat(log_path);

				if (file_stats.size >= max_bytes) {
					await moveLogFile(log_path, rotated_log_path);
				}
			}

			if (max_interval) {
				const min_since_last_rotate = Date.now() / 60000 - last_rotation_time;
				if (min_since_last_rotate >= max_interval) {
					await moveLogFile(log_path, rotated_log_path);
					last_rotation_time = Date.now() / 60000;
				}
			}
		}, LOG_ROTATE_INTERVAL).unref();
	} catch (err) {
		hdb_logger.error(err);
	}
}

async function moveLogFile(log_path, rotated_log_path) {
	const compress = env_mgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);
	const full_rotate_log_path = path.join(
		rotated_log_path,
		`HDB-${new Date(Date.now()).toISOString().replaceAll(':', '-')}.${compress ? 'log.gz' : 'log'}`
	);

	if (compress) {
		await pipe(createReadStream(log_path), createGzip(), createWriteStream(full_rotate_log_path));
		await fs_prom.unlink(log_path);
	} else {
		await fs_prom.rename(log_path, full_rotate_log_path);
	}

	// Close old log file.
	hdb_logger.closeLogFile();
	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdb_logger.notify(`hdb.log rotated, old log moved to ${full_rotate_log_path}`);
}
