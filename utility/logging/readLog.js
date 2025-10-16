'use strict';

const hdbTerms = require('../hdbTerms.ts');
const hdbLogger = require('./harper_logger.js');
const envMangr = require('../environment/environmentManager.js');
const validator = require('../../validation/readLogValidator.js');
const path = require('path');
const fs = require('fs-extra');
const { once } = require('events');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { PACKAGE_ROOT } = require('../../utility/packageUtils.js');
const { replicateOperation } = require('../../server/replication/replicator.ts');

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
			hdbErrors.HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	// start pulling logs from the other nodes now so it can be done in parallel
	let whenReplicatedResponse = replicateOperation(request);

	const logPath = envMangr.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const logName = request.log_name === undefined ? hdbTerms.LOG_NAMES.HDB : request.log_name;
	const readLogPath =
		logName === hdbTerms.LOG_NAMES.INSTALL
			? path.join(INSTALL_LOG_LOCATION, hdbTerms.LOG_NAMES.INSTALL)
			: path.join(logPath, logName);

	// support 'until' attribute for backwards compatibility
	if (request.to === undefined && request.until !== undefined) {
		request.to = request.until;
	}

	const levelDefined = request.level !== undefined;
	const level = levelDefined ? request.level : undefined;
	const fromDefined = request.from !== undefined;
	const from = fromDefined ? new Date(request.from) : undefined;
	const toDefined = request.to !== undefined;
	const to = toDefined ? new Date(request.to) : undefined;
	const limit = request.limit === undefined ? DEFAULT_READ_LOG_LIMIT : request.limit;
	const order = request.order === undefined ? undefined : request.order;
	const start = request.start === undefined ? 0 : request.start;
	const max = start + limit;
	let fileStart = 0;
	if (order === 'desc' && !from && !to) {
		fileStart = Math.max(fs.statSync(readLogPath).size - (max + 5) * ESTIMATED_AVERAGE_ENTRY_SIZE, 0);
	}
	const readLogInputStream = fs.createReadStream(readLogPath, { start: fileStart });
	readLogInputStream.on('error', (err) => {
		hdbLogger.error(err);
	});

	let count = 0;
	let result = [];
	let remaining = '';
	let pendingLogEntry;
	readLogInputStream.on('data', (logData) => {
		let reader = /(?:^|\n)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d.]+Z) \[(.+?)]: /g;
		logData = remaining + logData;
		let lastPosition = 0;
		let parsed;
		while ((parsed = reader.exec(logData))) {
			if (readLogInputStream.destroyed) break;
			if (pendingLogEntry) {
				pendingLogEntry.message = logData.slice(lastPosition, parsed.index);
				onLogMessage(pendingLogEntry);
			}
			let [intro, timestamp, tagsString] = parsed;
			let tags = tagsString.split('] [');
			let thread = tags[0];
			let level = tags[1];
			tags.splice(0, 2);
			pendingLogEntry = {
				timestamp,
				thread,
				level,
				tags,
				message: '',
			};
			lastPosition = parsed.index + intro.length;
		}
		remaining = logData.slice(lastPosition);
	});
	readLogInputStream.on('end', (logData) => {
		if (readLogInputStream.destroyed) return;
		if (pendingLogEntry) {
			pendingLogEntry.message = remaining.trim();
			onLogMessage(pendingLogEntry);
		}
	});
	readLogInputStream.resume();
	function onLogMessage(line) {
		let logDate;
		let fromDate;
		let toDate;
		switch (true) {
			case levelDefined && fromDefined && toDefined:
				logDate = new Date(line.timestamp);
				fromDate = new Date(from);
				toDate = new Date(to);

				// If the line matches the log level and timestamp falls between the from & to dates but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && logDate >= fromDate && logDate <= toDate && count < start) count++;
				// Else if all the criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && logDate >= fromDate && logDate <= toDate) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If all the criteria do not match, ignore the line and go to the next.
				break;
			case levelDefined && fromDefined:
				logDate = new Date(line.timestamp);
				fromDate = new Date(from);

				// If the line matches the log level and timestamp is equal/above the fromDate but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && logDate >= fromDate && count < start) count++;
				// Else if the level and from date criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && logDate >= fromDate) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case levelDefined && toDefined:
				logDate = new Date(line.timestamp);
				toDate = new Date(to);

				// If the line matches the log level and timestamp is equal/below the toDate but the result count is less that the start,
				// increment count and go to next line.
				if (line.level === level && logDate <= toDate && count < start) count++;
				// Else if the level and to date criteria match and the count is equal/above the start, push line to result array.
				else if (line.level === level && logDate <= toDate) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case fromDefined && toDefined:
				logDate = new Date(line.timestamp);
				fromDate = new Date(from);
				toDate = new Date(to);

				// If timestamp falls between the from & to dates but the result count is less that the start,
				// increment count and go to next line.
				if (logDate >= fromDate && logDate <= toDate && count < start) count++;
				// Else if all the criteria match and the count is equal/above the start, push line to result array.
				else if (logDate >= fromDate && logDate <= toDate) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If all the criteria do not match, ignore the line and go to the next.
				break;
			case levelDefined:
				// If line level matches but count is below start, just increment count
				if (line.level === level && count < start) count++;
				// If level matches and count is equal/above start, add line to result in increment count.
				else if (line.level === level) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If level criteria do not match, ignore the line and go to the next.
				break;
			case fromDefined:
				logDate = new Date(line.timestamp);
				fromDate = new Date(from);

				// If timestamp is equal/above the fromDate but the result count is less that the start,
				// increment count and go to next line.
				if (logDate >= fromDate && count < start) count++;
				// Else if from date criteria match and the count is equal/above the start, push line to result array.
				else if (logDate >= fromDate && count >= start) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
				}

				// If criteria do not match, ignore the line and go to the next.
				break;
			case toDefined:
				logDate = new Date(line.timestamp);
				toDate = new Date(to);

				// If timestamp is equal/below the toDate but the result count is less that the start,
				// increment count and go to next line.
				if (logDate <= toDate && count < start) count++;
				// Else if to date criteria match and the count is equal/above the start, push line to result array.
				else if (logDate <= toDate && count >= start) {
					pushLineToResult(line, order, result);
					count++;
					// If the count of matching lines is the max number of results, end the readline.
					if (count === max) readLogInputStream.destroy();
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
					if (count === max) readLogInputStream.destroy();
				}
		}
	}

	await once(readLogInputStream, 'close');
	let replicatedResponse = await whenReplicatedResponse;
	if (replicatedResponse.replicated) {
		// if this was a replicated request, add our node name to each of our own lines
		for (let line of result) {
			line.node = server.hostname;
		}
		// and then add the lines from the other nodes
		for (let nodeResult of replicatedResponse.replicated) {
			let node = nodeResult.node;
			if (nodeResult.status === 'failed') {
				// if the node failed to replicate, add an error line
				pushLineToResult(
					{
						timestamp: new Date().toISOString(),
						level: 'error',
						node,
						message: `Error retrieving logs: ${nodeResult.reason}`,
					},
					order,
					result
				);
			} else {
				for (let line of nodeResult.results) {
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
	const dateVal = new Date(value.timestamp);
	let low = 0;
	let high = result.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (new Date(result[mid].timestamp) > dateVal) low = mid + 1;
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
	const dateVal = new Date(value.timestamp);
	let low = 0;
	let high = result.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (new Date(result[mid].timestamp) < dateVal) low = mid + 1;
		else high = mid;
	}

	result.splice(low, 0, value);
}
