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
import { StringDecoder } from 'string_decoder';

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
// Cap the live-tail backlog regardless of a caller-supplied `limit`, so an unbounded `limit`
// can neither seek-read a huge slice into memory nor drive an O(n·limit) eviction on connect.
// Deeper history is the buffered read_log's job; the tail is about what happens next.
const MAX_SSE_BACKLOG_ENTRIES = 1000;
// Push decoded text to the parser in slices this size, yielding to backpressure between them
// so a big burst in one poll window can't emit unbounded frames ahead of a slow client.
const TAIL_PUSH_SLICE_BYTES = 65536;
// A transient delta-read failure is retried this many times (with this delay) before the tail
// gives up and emits a terminal error so the client can fall back to polling.
const TAIL_READ_MAX_RETRIES = 3;
const TAIL_READ_RETRY_MS = 250;

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

// Stateful incremental parser: fed appended chunks over time, it emits an entry as soon as
// the next marker delimits its (possibly multi-line) message. `flush()` finalizes the last
// pending entry and is only safe at a real end-of-input (the bounded backlog snapshot) — the
// live tail never flushes, so a partial mid-write entry is never emitted or its continuation
// discarded; it stays pending until the next marker delimits it.
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
 * Stream the local log over SSE: emit the recent (bounded) backlog, then tail newly-appended
 * lines until the client disconnects (the emitter's `signal` aborts) — or, if reads fail past
 * retry, emit a terminal `error` so the client falls back to polling instead of watching a
 * silently-stalled "live" stream. Resolves when the tail ends so the SSE wrapper can close.
 */
function streamLogTail(progress: any, params: TailFilterParams): Promise<void> {
	const { readLogPath, limit } = params;
	const signal: AbortSignal | undefined = progress.signal;
	const emit = (entry: LogEntry) => progress.emit('log', entry);
	// The tail never shows more backlog than this, whatever `limit` asks for (see the constant).
	const backlogLimit = Math.min(limit, MAX_SSE_BACKLOG_ENTRIES);

	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();

		let offset = 0;
		let pumping = false;
		let watching = false;
		let finished = false;
		let readFailures = 0;
		// One decoder for the whole tail: a multi-byte char split across two poll windows is held
		// until its continuing bytes arrive on the next read, instead of flushed as U+FFFD.
		let decoder = new StringDecoder('utf8');
		const parser = createIncrementalLogParser((entry) => {
			if (matchesLogFilters(entry, params)) emit(entry);
		});

		function finish() {
			if (finished) return;
			finished = true;
			if (watching) fs.unwatchFile(readLogPath, onChange);
			resolve();
		}

		// Wait `ms`, or resolve early on disconnect so a retry delay never outlives the connection.
		const abortableDelay = (ms: number) =>
			new Promise<void>((res) => {
				if (signal?.aborted) return res();
				const timer = setTimeout(() => {
					signal?.removeEventListener('abort', onAbort);
					res();
				}, ms);
				timer.unref?.();
				const onAbort = () => {
					clearTimeout(timer);
					res();
				};
				signal?.addEventListener('abort', onAbort, { once: true });
			});

		// Push decoded text to the parser in bounded slices, yielding to backpressure between
		// slices, so a big burst in one poll window can't emit frames faster than a slow client
		// drains them (the pump's top-level pause only gates whole polls, not within one push).
		const pushWithBackpressure = async (text: string) => {
			for (let i = 0; i < text.length; i += TAIL_PUSH_SLICE_BYTES) {
				if (signal?.aborted) return;
				parser.push(text.slice(i, i + TAIL_PUSH_SLICE_BYTES));
				if (progress.paused) await progress.whenWritable();
			}
		};

		// Read [start, end] inclusive as raw bytes → Buffer, or `null` if the read errored
		// (logged). Bytes are only decoded/consumed by the caller on success, so a failed read
		// leaves the session decoder and `offset` untouched and the range can be retried cleanly.
		const readRange = (start: number, end: number): Promise<Buffer | null> =>
			new Promise((res) => {
				const buffers: Buffer[] = [];
				const rs = fs.createReadStream(readLogPath, { start, end });
				rs.on('data', (data) => buffers.push(data as Buffer));
				rs.on('error', (err) => {
					hdbLogger.warn(`read_log SSE tail: failed to read ${readLogPath} [${start}, ${end}]: ${err?.message ?? err}`);
					res(null);
				});
				rs.on('close', () => res(Buffer.concat(buffers)));
			});

		// Single-flight pump: drain all appended bytes into the parser. Re-entrant calls while a
		// pump is running are no-ops; the loop re-stats each turn and picks up newly-written bytes.
		async function pump() {
			if (pumping) return;
			pumping = true;
			try {
				while (!signal?.aborted) {
					let size: number;
					try {
						size = (await fs.promises.stat(readLogPath)).size;
					} catch {
						break;
					}
					if (size < offset) {
						// Truncation or rotation: restart from the new file and reset decode/parse state.
						offset = 0;
						decoder = new StringDecoder('utf8');
						parser.reset();
					}
					if (size <= offset) break;
					if (progress.paused) {
						await progress.whenWritable();
						continue;
					}
					const start = offset;
					const buffer = await readRange(start, size - 1);
					if (signal?.aborted) break;
					if (buffer === null) {
						if (++readFailures > TAIL_READ_MAX_RETRIES) {
							// Don't leave the client staring at a silently-stalled "live" stream: a
							// terminal error is its cue to fall back to polling.
							progress.emit('error', {
								message: `read_log live tail could not read ${readLogPath} after ${TAIL_READ_MAX_RETRIES} retries`,
								code: 'READ_LOG_TAIL_READ_ERROR',
							});
							finish();
							return;
						}
						await abortableDelay(TAIL_READ_RETRY_MS);
						continue; // retry the same range; offset stays put
					}
					readFailures = 0;
					offset = size;
					await pushWithBackpressure(decoder.write(buffer));
				}
			} finally {
				pumping = false;
			}
		}

		function onChange() {
			void pump();
		}

		const startTail = () => {
			// `offset` is already the backlog boundary, so the tail picks up strictly from there —
			// no line dropped or double-sent across the handoff. Without a disconnect signal we
			// can't safely tail forever; degrade to backlog-only so the client polls instead.
			if (!signal || signal.aborted) return finish();
			fs.watchFile(readLogPath, { interval: TAIL_POLL_INTERVAL_MS }, onChange);
			watching = true;
			signal.addEventListener('abort', finish, { once: true });
			// Catch anything appended between the backlog snapshot and arming the watcher.
			void pump();
		};

		// Emit the backlog first (newest `backlogLimit` matching entries, oldest-first), then tail.
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
		// Bound the backlog read to roughly the last `backlogLimit` entries so a large log file
		// can't be pulled into memory all at once (mirrors the buffered path's tail-seek). A
		// partial first line the seek lands in is dropped by the parser, as in the buffered path.
		const backlogStart = Math.max(startSize - (backlogLimit + 5) * ESTIMATED_AVERAGE_ENTRY_SIZE, 0);
		// Keep only the newest `backlogLimit` matching entries as we parse, so even a window denser
		// than estimated can't grow this array without bound (and the eviction stays O(backlogLimit)).
		const backlogEntries: LogEntry[] = [];
		const backlogParser = createIncrementalLogParser((entry) => {
			if (!matchesLogFilters(entry, params)) return;
			backlogEntries.push(entry);
			if (backlogEntries.length > backlogLimit) backlogEntries.shift();
		});
		const backlogStream = fs.createReadStream(readLogPath, {
			start: backlogStart,
			end: startSize - 1,
			encoding: 'utf8',
		});
		backlogStream.on('data', (data) => backlogParser.push(String(data)));
		backlogStream.on('error', (err) =>
			hdbLogger.warn(`read_log SSE tail: failed to read backlog from ${readLogPath}: ${err?.message ?? err}`)
		);
		backlogStream.on('close', async () => {
			backlogParser.flush();
			// Emit the backlog under the same backpressure as the live tail: a slow client with a
			// large (multi-line) backlog would otherwise get the whole thing buffered at once.
			for (const entry of backlogEntries) {
				if (signal?.aborted) break;
				emit(entry);
				if (progress.paused) await progress.whenWritable();
			}
			startTail();
		});
	});
}
