'use strict';

const hdb_terms = require('../hdbTerms');
const hdb_logger = require('./harper_logger');
const env_mangr = require('../environment/environmentManager');
const validator = require('../../validation/readLogValidator');
const path = require('path');
const fs = require('fs-extra');
const { once } = require('events');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { PACKAGE_ROOT } = require('../../utility/packageUtils');
const { replicateOperation } = require('../../server/replication/replicator');

// Install log is created in harperdb/logs because the hdb folder doesn't exist initially during the install process.
const INSTALL_LOG_LOCATION = path.join(PACKAGE_ROOT, `logs`);
const DEFAULT_READ_LOG_LIMIT = 1000;
const ESTIMATED_AVERAGE_ENTRY_SIZE = 200;

module.exports = readLog;

/**
 * Reads a log via a read stream and filters lines if filter params are passed.
 * Returns an object array where each object is a line from the log.
 * @param request
 * @returns {Promise<*[]>}
 */
async function readLog(request) {
	const validation = validator(request);
	if (validation) {
		throw handleHDBError(
			validation,
			validation.message,
			hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	// start pulling logs from the other nodes now so it can be done in parallel
	let when_replicated_response = replicateOperation(request);

	const log_path = env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const log_name = request.log_name === undefined ? hdb_terms.LOG_NAMES.HDB : request.log_name;
	const read_log_path =
		log_name === hdb_terms.LOG_NAMES.INSTALL
			? path.join(INSTALL_LOG_LOCATION, hdb_terms.LOG_NAMES.INSTALL)
			: path.join(log_path, log_name);

	const level_defined = request.level !== undefined;
	const level = level_defined ? request.level : undefined;
	const from_defined = request.from !== undefined;
	const from = from_defined ? new Date(request.from) : undefined;
	const until_defined = request.until !== undefined;
	const until = until_defined ? new Date(request.until) : undefined;
	const limit = request.limit === undefined ? DEFAULT_READ_LOG_LIMIT : request.limit;
	const order = request.order === undefined ? undefined : request.order;
	const start = request.start === undefined ? 0 : request.start;
	const max = start + limit;
	let file_start = 0;
	if (order === 'desc' && !from && !until) {
		file_start = Math.max(fs.statSync(read_log_path).size - (max + 5) * ESTIMATED_AVERAGE_ENTRY_SIZE, 0);
	}
	const read_log_input_stream = fs.createReadStream(read_log_path, { start: file_start });
	read_log_input_stream.on('error', (err) => {
		hdb_logger.error(err);
	});

	let count = 0;
	let result = [];
	let remaining = '';
	let pending_log_entry;
	read_log_input_stream.on('data', (log_data) => {
		let reader = /(?:^|\n)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d\.]+Z) \[(.+?)]: /g;
		log_data = remaining + log_data;
		let last_position = 0;
		let parsed;
		while ((parsed = reader.exec(log_data))) {
			if (read_log_input_stream.destroyed) break;
			if (pending_log_entry) {
				pending_log_entry.message = log_data.slice(last_position, parsed.index);
				onLogMessage(pending_log_entry);
			}
			let [intro, timestamp, tags_string] = parsed;
			let tags = tags_string.split('] [');
			let thread = tags[0];
			let level = tags[1];
			tags.splice(0, 2);
			pending_log_entry = {
				timestamp,
				thread,
				level,
				tags,
				message: '',
			};
			last_position = parsed.index + intro.length;
		}
		remaining = log_data.slice(last_position);
	});
	read_log_input_stream.on('end', (log_data) => {
		if (read_log_input_stream.destroyed) return;
		if (pending_log_entry) {
			pending_log_entry.message = remaining.trim();
			onLogMessage(pending_log_entry);
		}
	});
	read_log_input_stream.resume();
	function onLogMessage(line) {
		let log_date;
		let from_date;
		let until_date;
		switch (true) {
			case level_defined && from_defined && until_defined:
				log_date = new Date(line.timestamp);
				from_date = new Date(from);
				until_date = new Date(until);

				// If the line matches the log level and timestamp falls between the from & until dates but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && log_date >= from_date && log_date <= until_date && count < start) count++;
				// Else if all the criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && log_date >= from_date && log_date <= until_date) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If all the criteria do not match, ignore the line and go to the next.
				break;
			case level_defined && from_defined:
				log_date = new Date(line.timestamp);
				from_date = new Date(from);

				// If the line matches the log level and timestamp is equal/above the from_date but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && log_date >= from_date && count < start) count++;
				// Else if the level and from date criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && log_date >= from_date) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case level_defined && until_defined:
				log_date = new Date(line.timestamp);
				until_date = new Date(until);

				// If the line matches the log level and timestamp is equal/below the until_date but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && log_date <= until_date && count < start) count++;
				// Else if the level and until date criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && log_date <= until_date) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case from_defined && until_defined:
				log_date = new Date(line.timestamp);
				from_date = new Date(from);
				until_date = new Date(until);

				// If timestamp falls between the from & until dates but the result count is less that the start,
				// increment count and go to next line.
				if (log_date >= from_date && log_date <= until_date && count < start) count++;
				// Else if all the criteria match and the count is equal/above the start, push line to result array.
				else if (log_date >= from_date && log_date <= until_date) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If all the criteria do not match, ignore the line and go to the next.
				break;
			case level_defined:
				// If line level matches but count is below start, just increment count
				if (line.level === level && count < start) count++;
				// If level matches and count is equal/above start, add line to result in increment count.
				else if (line.level === level) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If level criteria do not match, ignore the line and go to the next.
				break;
			case from_defined:
				log_date = new Date(line.timestamp);
				from_date = new Date(from);

				// If timestamp is equal/above the from_date but the result count is less that the start,
				// increment count and go to next line.
				if (log_date >= from_date && count < start) count++;
				// Else if from date criteria match and the count is equal/above the start, push line to result array.
				else if (log_date >= from_date && count >= start) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case until_defined:
				log_date = new Date(line.timestamp);
				until_date = new Date(until);

				// If timestamp is equal/below the until_date but the result count is less that the start,
				// increment count and go to next line.
				if (log_date <= until_date && count < start) count++;
				// Else if until date criteria match and the count is equal/above the start, push line to result array.
				else if (log_date <= until_date && count >= start) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			default:
				// If count is under the start, increment count and go to next line
				if (count < start) count++;
				// Else push line to result and increment count
				else {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) read_log_input_stream.destroy();
				}
		}
	}

	await once(read_log_input_stream, 'close');
	let replicated_response = await when_replicated_response;
	if (replicated_response.replicated) {
		// if this was a replicated request, add our node name to each of our own lines
		for (let line of result) {
			line.node = server.hostname;
		}
		// and then add the lines from the other nodes
		for (let node_result of replicated_response.replicated) {
			let node = node_result.node;
			if (node_result.status === 'failed') {
				// if the node failed to replicate, add an error line
				pushLineToResult(
					{
						timestamp: new Date().toISOString(),
						level: 'error',
						node,
						message: `Error retrieving logs: ${node_result.reason}`,
					},
					order,
					result
				);
			} else {
				for (let line of node_result.results) {
					line.node = node;
					pushLineToResult(line, order, result);
				}
			}
		}
	}
	return result;
}

/**
 * Pushes a line from the readline stream to the result array.
 * If an order was passed in request, insert the line in the correct order.
 * @param line
 * @param order
 * @param result
 */
function pushLineToResult(line, order, result) {
	if (order === 'desc') {
		insertDescending(line, result);
	} else if (order === 'asc') {
		insertAscending(line, result);
	} else {
		result.push(line);
	}
}

/**
 * Insert a line from log into result array in descending order by date.
 * @param value
 * @param result
 */
function insertDescending(value, result) {
	const date_val = new Date(value.timestamp);
	let low = 0;
	let high = result.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (new Date(result[mid].timestamp) > date_val) low = mid + 1;
		else high = mid;
	}

	result.splice(low, 0, value);
}

/**
 * Insert a line from log into result array in descending order by date.
 * @param value
 * @param result
 */
function insertAscending(value, result) {
	const date_val = new Date(value.timestamp);
	let low = 0;
	let high = result.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (new Date(result[mid].timestamp) < date_val) low = mid + 1;
		else high = mid;
	}

	result.splice(low, 0, value);
}
