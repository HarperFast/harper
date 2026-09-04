/**
 * Shared helpers for the SSE streaming regression suites in `integrationTests/server/`
 * (`sse-finite-generator.test.ts`, `sse-throw-midstream.test.ts`): a bounded SSE consumer, a
 * `/Probe/` reader for the lifecycle counters those fixtures keep, and an `hdb.log`
 * uncaughtException counter — the bugs these suites anchor surfaced as an uncaught throw inside
 * the worker rather than as a bad response.
 *
 * The raw-socket capture in `stream-error-contract.test.ts` is a deliberately different
 * technique (it inspects chunk framing and the exact close mechanism) and is not shared.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface SseResult {
	status: number;
	raw: string;
	events: string[];
	/** which response event resolved the request; null when our own timeout fired instead */
	terminatedBy: 'end' | 'error' | 'close' | null;
	/** did our own timeout abort fire — i.e. the response hung? */
	aborted: boolean;
	errored: Error | null;
	elapsedMs: number;
}

function parseEvents(raw: string): string[] {
	return raw
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => line.slice('data: '.length));
}

/**
 * Consume an SSE response, bounded by an AbortController.
 *
 * Resolves on whichever of 'end' / 'error' / 'close' fires first: the pipeline()-based teardown
 * introduced by #1789 closes the response abruptly rather than via a clean 'end' when the source
 * generator rejects, so waiting only for 'end' would read a correct abrupt close as a hang.
 *
 * `aborted` is decided by our own timer rather than by which event won the race to settle. An
 * abort destroys the response, so a hung stream emits 'close' too — attributing the settle to
 * that event would report a genuine hang as a bounded termination.
 */
export function consumeSse(
	urlStr: string,
	authHeaders: Record<string, string>,
	timeoutMs = 12_000
): Promise<SseResult> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const controller = new AbortController();
	let timedOut = false;
	const start = Date.now();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return new Promise((resolvePromise) => {
		const result: SseResult = {
			status: 0,
			raw: '',
			events: [],
			terminatedBy: null,
			aborted: false,
			errored: null,
			elapsedMs: 0,
		};
		let settled = false;
		let flushDecoder: (() => string) | null = null;
		const finish = (terminatedBy: SseResult['terminatedBy'], err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// An abrupt close settles through 'error'/'close', so flushing only on 'end' would drop a
			// multi-byte character the decoder was still holding.
			if (flushDecoder) result.raw += flushDecoder();
			result.aborted = timedOut;
			result.terminatedBy = timedOut ? null : terminatedBy;
			result.errored = err ?? null;
			result.elapsedMs = Date.now() - start;
			result.events = parseEvents(result.raw);
			resolvePromise(result);
		};
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { ...authHeaders, Accept: 'text/event-stream' },
				rejectUnauthorized: false,
				signal: controller.signal,
			} as any,
			(res) => {
				result.status = res.statusCode ?? 0;
				// A bare d.toString('utf8') per chunk corrupts any multi-byte character that straddles
				// a TCP chunk boundary into U+FFFD.
				const decoder = new StringDecoder('utf8');
				flushDecoder = () => decoder.end();
				res.on('data', (d: Buffer) => {
					result.raw += decoder.write(d);
				});
				res.on('end', () => finish('end'));
				res.on('error', (e: Error) => finish('error', e));
				res.on('close', () => finish('close'));
			}
		);
		req.on('error', (e: any) => {
			if (timedOut) finish(null);
			else finish('error', e);
		});
		req.end();
	});
}

export function getProbe<T>(restBase: string, authHeaders: Record<string, string>, timeoutMs = 3_000): Promise<T> {
	const url = new URL(`${restBase}/Probe/`);
	const lib = url.protocol === 'https:' ? https : http;
	return new Promise((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { ...authHeaders, Accept: 'application/json' },
				rejectUnauthorized: false,
				signal: AbortSignal.timeout(timeoutMs),
			} as any,
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (d: Buffer) => chunks.push(d));
				res.on('end', () => {
					try {
						resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					} catch (e) {
						reject(e);
					}
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

/**
 * Poll `/Probe/` until `predicate` holds. A generator's `finally` block runs after the response
 * has already terminated, so its close counter is not readable the instant the client resolves.
 * Returns the last snapshot read (which may not satisfy the predicate) or null if none was.
 */
export async function waitForProbe<T>(
	restBase: string,
	authHeaders: Record<string, string>,
	predicate: (probe: T) => boolean,
	timeoutMs = 5_000
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	let probe: T | null = null;
	while (Date.now() < deadline) {
		probe = await getProbe<T>(restBase, authHeaders, Math.max(1, deadline - Date.now())).catch(() => null);
		// A predicate reading counter fields off an error payload throws; that is "not satisfied
		// yet", and the caller asserts on the snapshot this returns.
		try {
			if (probe && predicate(probe)) return probe;
		} catch {
			/* not satisfied */
		}
		await sleep(50);
	}
	return probe;
}

/**
 * Wait for a freshly installed SSE fixture's `/Probe/` route, and take the suite's baseline
 * uncaughtException count.
 *
 * The baseline is read with `readFileSync`, not `readLogSafe`: an hdb.log this suite cannot read
 * (a changed harness layout, a log not yet created) would otherwise turn every uncaughtException
 * assertion downstream into a vacuous pass, since a missing file counts zero both before and
 * after. Failing setup is the only way that stays visible.
 */
export async function awaitFixtureReady(
	harper: { logDir?: string; dataRootDir?: string },
	restBase: string,
	authHeaders: Record<string, string>,
	timeoutMs = 30_000
): Promise<{ logPath: string; uncaughtBaseline: number }> {
	const logPath = harper.logDir ? join(harper.logDir, 'hdb.log') : join(harper.dataRootDir as string, 'log', 'hdb.log');
	const deadline = Date.now() + timeoutMs;
	let ready = false;
	while (Date.now() < deadline) {
		const probe = await getProbe<{ ok?: boolean }>(restBase, authHeaders).catch(() => null);
		if (probe?.ok !== undefined) {
			ready = true;
			break;
		}
		await sleep(250);
	}
	if (!ready) throw new Error(`Probe route did not become ready within ${timeoutMs}ms at ${restBase}/Probe/`);
	// Polled, not read once: the HTTP port can answer before the log writer has created the file.
	while (Date.now() < deadline) {
		try {
			return { logPath, uncaughtBaseline: countUncaught(readFileSync(logPath, 'utf8')) };
		} catch {
			await sleep(100);
		}
	}
	throw new Error(`hdb.log never became readable at ${logPath} — uncaughtException checks would pass vacuously`);
}

/** For the end-of-suite sweep: a log that vanished mid-run must fail, not silently count zero. */
export function readLogOrThrow(logPath: string): string {
	return readFileSync(logPath, 'utf8');
}

export function readLogSafe(logPath: string): string {
	try {
		return readFileSync(logPath, 'utf8');
	} catch {
		return '';
	}
}

export function uncaughtLines(log: string): string[] {
	return log.split('\n').filter((line) => line.includes('uncaughtException'));
}

export function countUncaught(log: string): number {
	return uncaughtLines(log).length;
}

/**
 * Asserting a NON-event: the worker logs an uncaughtException asynchronously, so reading hdb.log
 * the instant the response closes can pass vacuously by simply outrunning the flush. Give the
 * writer a bounded settle first — one of the cases AGENTS.md reserves a fixed sleep for.
 */
export async function uncaughtAfterSettle(logPath: string): Promise<number> {
	await sleep(1_000);
	return countUncaught(readLogSafe(logPath));
}
