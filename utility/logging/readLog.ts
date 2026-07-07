'use strict';

import * as hdbTerms from '../hdbTerms.ts';
import hdbLogger from './harper_logger.ts';
import validator from '../../validation/readLogValidator.ts';
import * as path from 'path';
import * as fs from 'fs-extra';
import { once } from 'events';
import { getConfigPath } from '../../config/configUtils.ts';
import { handleHDBError, hdbErrors } from '../errors/hdbError.ts';
import { server } from '../../server/Server.ts';

const DEFAULT_READ_LOG_LIMIT = 1000;
const ESTIMATED_AVERAGE_ENTRY_SIZE = 200;

export default readLog;

/**
 * Reads a log via a read stream and filters lines if filter params are passed.
 * Returns an object array where each object is a line from the log.
 * @param request
 * @returns {Promise<*[]>}
 */
async function readLog(request: any) {
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
	// Start pulling logs from the other nodes now so it can be done in parallel. A live SSE
	// tail (below) is local-only and never fans out, so skip replication on that path — the
	// buffered read still aggregates the cluster for point-in-time queries.
	let whenReplicatedResponse = isStreamingRequest(request) ? undefined : server.replication.replicateOperation(request);

	const logPath = getConfigPath(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const rawLogName = request.log_name === undefined ? hdbTerms.LOG_NAMES.HDB : request.log_name;
	const logName = path.extname(rawLogName) === '.log' ? rawLogName : `${rawLogName}.log`;
	const readLogPath = path.join(logPath, logName);

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
	const filter = request.filter;

	// SSE mode: the server attached a ProgressEmitter as `request.progress` (see
	// serverHandlers.js) because the client sent `Accept: text/event-stream`. Instead of a
	// one-shot array, stream the recent backlog and then tail new lines live until the client
	// disconnects. Scoped to this node's log file; the buffered path above is what aggregates
	// the cluster for point-in-time reads.
	if (isStreamingRequest(request)) {
		return streamLogTail(request.progress, {
			readLogPath,
			level,
			levelDefined,
			from,
			fromDefined,
			to,
			toDefined,
			limit,
			filter,
		});
	}

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
	let processedCount = 0;
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
	readLogInputStream.on('end', () => {
		if (readLogInputStream.destroyed) return;
		if (pendingLogEntry) {
			pendingLogEntry.message = remaining.trim();
			onLogMessage(pendingLogEntry);
		}
	});
	readLogInputStream.resume();
	function onLogMessage(line: any) {
		if (filter !== undefined) {
			let found = false;
			if (
				['timestamp', 'thread', 'level', 'tags', 'message'].some((attr) => {
					if (Array.isArray(line[attr])) {
						return line[attr].some((val) => val.includes(filter));
					}
					return line[attr].includes(filter);
				})
			) {
				found = true;
			}
			if (!found) return;
		}

		// Yield to event loop every 10 lines to heavily deprioritize this filtering relative to other operations
		processedCount++;
		if (processedCount % 10 === 0) {
			readLogInputStream.pause();
			setImmediate(() => readLogInputStream.resume());
		}

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
		for (let nodeResult of (replicatedResponse as any).replicated) {
			let node = (nodeResult as any).node;
			if ((nodeResult as any).status === 'failed') {
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
				for (let line of (nodeResult as any).results) {
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
function pushLineToResult(line: any, order: string | undefined, result: any[]) {
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
function insertDescending(value: any, result: any[]) {
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
function insertAscending(value: any, result: any[]) {
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

interface LogEntry {
	timestamp: string;
	thread: string;
	level: string;
	tags: string[];
	message: string;
}

interface TailFilterParams {
	readLogPath: string;
	level: string | undefined;
	levelDefined: boolean;
	from: Date | undefined;
	fromDefined: boolean;
	to: Date | undefined;
	toDefined: boolean;
	limit: number;
	filter: string | undefined;
}

// The marker that begins every log line — `TIMESTAMP [thread] [level]...: ` — matching the
// buffered reader's regex so the two paths parse identically.
const LOG_ENTRY_MARKER = /(?:^|\n)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d.]+Z) \[(.+?)]: /g;
// How often a live tail polls the log file for appended bytes. fs.watchFile is stat-poll
// based, which is far more robust across platforms and log rotation than fs.watch's rename
// events; sub-second latency is plenty for a human watching logs.
const TAIL_POLL_INTERVAL_MS = 250;
// A trailing entry can't be finalized until the next marker delimits its (possibly
// multi-line) message, so after this long without new bytes we flush it as-is.
const TAIL_IDLE_FLUSH_MS = 1000;

function isStreamingRequest(request: any): boolean {
	return !!request.progress && typeof request.progress.emit === 'function';
}

function makeLogEntry(timestamp: string, tagsString: string, message: string): LogEntry {
	const tags = tagsString.split('] [');
	const thread = tags[0];
	const level = tags[1];
	tags.splice(0, 2);
	return { timestamp, thread, level, tags, message };
}

function matchesLogFilters(entry: LogEntry, params: TailFilterParams): boolean {
	const { level, levelDefined, from, fromDefined, to, toDefined, filter } = params;
	if (filter !== undefined) {
		const hit = (['timestamp', 'thread', 'level', 'tags', 'message'] as const).some((attr) => {
			const value = entry[attr];
			if (Array.isArray(value)) return value.some((v) => v.includes(filter));
			return typeof value === 'string' && value.includes(filter);
		});
		if (!hit) return false;
	}
	if (levelDefined && entry.level !== level) return false;
	if (fromDefined || toDefined) {
		const when = new Date(entry.timestamp);
		if (fromDefined && when < (from as Date)) return false;
		if (toDefined && when > (to as Date)) return false;
	}
	return true;
}

// Stateful incremental parser: fed appended chunks over time, it emits an
// entry as soon as the next marker delimits its message; `flush()` finalizes the last pending
// entry (called on idle so a quiet tail still surfaces its newest line).
function createIncrementalLogParser(onEntry: (entry: LogEntry) => void) {
	let remaining = '';
	let pending: { timestamp: string; tagsString: string } | undefined;
	// One RegExp per parser instance. Each push runs `exec` to completion (until null), which
	// resets lastIndex to 0; we also reset it explicitly at the top of push for robustness.
	const reader = new RegExp(LOG_ENTRY_MARKER);
	return {
		push(text: string) {
			const data = remaining + text;
			reader.lastIndex = 0;
			let lastPosition = 0;
			let parsed;
			while ((parsed = reader.exec(data))) {
				if (pending) {
					onEntry(makeLogEntry(pending.timestamp, pending.tagsString, data.slice(lastPosition, parsed.index)));
				}
				const [intro, timestamp, tagsString] = parsed;
				pending = { timestamp, tagsString };
				lastPosition = parsed.index + intro.length;
			}
			remaining = data.slice(lastPosition);
		},
		flush() {
			if (pending) {
				onEntry(makeLogEntry(pending.timestamp, pending.tagsString, remaining.trim()));
				pending = undefined;
				remaining = '';
			}
		},
		reset() {
			pending = undefined;
			remaining = '';
		},
	};
}

/**
 * Stream the local log over SSE: emit the recent backlog, then tail newly-appended lines
 * until the client disconnects (the emitter's `signal` aborts). Resolves when the tail ends
 * so the SSE wrapper can close the response.
 */
function streamLogTail(progress: any, params: TailFilterParams): Promise<void> {
	const { readLogPath, limit } = params;
	const signal: AbortSignal | undefined = progress.signal;
	const emit = (entry: LogEntry) => progress.emit('log', entry);

	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();

		let offset = 0;
		let reading = false;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const parser = createIncrementalLogParser((entry) => {
			if (matchesLogFilters(entry, params)) emit(entry);
		});

		const scheduleIdleFlush = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => parser.flush(), TAIL_IDLE_FLUSH_MS);
			idleTimer.unref?.();
		};

		// Read the newly-appended bytes [offset, size) and feed them to the incremental parser.
		// A `reading` guard serializes overlapping reads; after each read we re-check the size so
		// a burst that landed mid-read isn't stranded until the next write.
		const readDelta = (size: number) => {
			if (reading) return;
			if (size < offset) {
				// Truncation or rotation: start over from the new file's beginning.
				offset = 0;
				parser.reset();
			}
			if (size <= offset) return;
			reading = true;
			const start = offset;
			const end = size - 1;
			offset = size;
			let chunk = '';
			const deltaStream = fs.createReadStream(readLogPath, { start, end, encoding: 'utf8' });
			deltaStream.on('data', (data) => {
				chunk += data;
			});
			deltaStream.on('error', () => {
				reading = false;
			});
			deltaStream.on('close', () => {
				parser.push(chunk);
				scheduleIdleFlush();
				reading = false;
				fs.stat(readLogPath, (err, stats) => {
					if (!err && stats.size > offset) readDelta(stats.size);
				});
			});
		};

		const onChange = (curr: fs.Stats) => readDelta(curr.size);

		const startTail = () => {
			// `offset` is already the backlog boundary, so the tail picks up strictly from there —
			// no line dropped or double-sent across the handoff.
			// Without a disconnect signal we can't safely tail forever; degrade to backlog-only so
			// the client falls back to polling for subsequent changes.
			if (!signal) return resolve();
			fs.watchFile(readLogPath, { interval: TAIL_POLL_INTERVAL_MS }, onChange);
			const stop = () => {
				fs.unwatchFile(readLogPath, onChange);
				if (idleTimer) clearTimeout(idleTimer);
				resolve();
			};
			if (signal.aborted) return stop();
			signal.addEventListener('abort', stop, { once: true });
			// Catch anything appended between the backlog snapshot and arming the watcher; without
			// this a burst that lands in that window waits for the next write to be noticed.
			fs.stat(readLogPath, (err, stats) => {
				if (!err) readDelta(stats.size);
			});
		};

		// Emit the backlog first (newest `limit` matching entries, oldest-first), then begin tailing.
		let startSize = 0;
		try {
			startSize = fs.statSync(readLogPath).size;
		} catch {
			startSize = 0;
		}
		offset = startSize;
		if (startSize === 0) {
			startTail();
			return;
		}
		// Bound the backlog read to roughly the last `limit` entries so a large log file can't be
		// pulled into memory all at once (mirrors the buffered path's tail-seek). We over-read a
		// little to avoid clipping, parse it incrementally, filter, and keep the newest `limit`. A
		// partial first line the seek lands in is dropped by the parser, as in the buffered path.
		const backlogStart = Math.max(startSize - (limit + 5) * ESTIMATED_AVERAGE_ENTRY_SIZE, 0);
		const backlogEntries: LogEntry[] = [];
		const backlogParser = createIncrementalLogParser((entry) => backlogEntries.push(entry));
		const backlogStream = fs.createReadStream(readLogPath, {
			start: backlogStart,
			end: startSize - 1,
			encoding: 'utf8',
		});
		backlogStream.on('data', (data) => backlogParser.push(String(data)));
		backlogStream.on('error', () => {});
		backlogStream.on('close', () => {
			backlogParser.flush();
			const matched = backlogEntries.filter((entry) => matchesLogFilters(entry, params));
			for (const entry of matched.slice(-limit)) emit(entry);
			startTail();
		});
	});
}
