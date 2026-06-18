import { isMainThread } from 'node:worker_threads';
import { coolTransactionLogs } from '@harperfast/rocksdb-js';
import { logger } from '../utility/logging/logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import { convertToMS } from '../utility/common_utils.ts';
envMgr.initSync();

// Cooling is cheap and non-destructive, so a modest default cadence keeps
// already-read log pages on the inactive LRU during long replication catch-ups
// without meaningful overhead. Set storage.transactionLog.coolingInterval to 0
// to disable.
const DEFAULT_COOLING_INTERVAL = 30000;

// coolTransactionLogs() advises every mapped transaction log's file-backed pages
// cold (MADV_COLD) so the kernel reclaims them first under memory pressure. It is
// a process-global no-op until @harperfast/rocksdb-js ships it (the release that
// includes HarperFast/rocksdb-js#652); guard so an older installed binding does
// not throw.
let cool: (() => { maps: number; bytes: number }) | undefined =
	typeof coolTransactionLogs === 'function' ? coolTransactionLogs : undefined;

let coolingTimer: NodeJS.Timeout | undefined;

/**
 * Run a single cooling pass over the process-global transaction log registry.
 * Non-destructive: a re-read of a not-yet-reclaimed cold page just re-activates
 * it, so this is safe alongside the concurrent, not-perfectly-sequential reader
 * pattern (replication + real-time consumers at different offsets).
 */
export function runCoolingPass(): void {
	if (!cool) return;
	try {
		const { maps, bytes } = cool();
		if (maps > 0) logger.trace?.(`Cooled ${maps} transaction log map(s) (${bytes} bytes)`);
	} catch (error) {
		logger.error?.('Error cooling transaction logs', error);
	}
}

function scheduleCooling(interval: number): void {
	coolingTimer = setTimeout(() => {
		runCoolingPass();
		scheduleCooling(interval);
	}, interval).unref();
}

/**
 * Start the periodic transaction-log cooling timer. The rocksdb-js transaction
 * log registry is a process-global singleton shared across worker threads, and
 * cooling needs no worker-resident state, so it is driven from the single,
 * process-stable main thread — unlike worker-bound maintenance such as audit
 * cleanup and storage reclamation, which use the last worker. Driving it from a
 * worker would leave gaps in the cadence whenever that worker is recycled, which
 * is precisely during the long catch-ups this targets. Idempotent and a no-op
 * off the main thread or when cooling is unavailable/disabled.
 */
export function startTransactionLogCooling(): void {
	if (!isMainThread || coolingTimer) return;
	if (!cool) {
		logger.debug?.('Transaction log cooling unavailable; @harperfast/rocksdb-js does not expose coolTransactionLogs()');
		return;
	}
	const configured = envMgr.get(CONFIG_PARAMS.STORAGE_TRANSACTIONLOG_COOLINGINTERVAL);
	let interval = configured == null ? DEFAULT_COOLING_INTERVAL : convertToMS(configured);
	if (Number.isNaN(interval)) {
		// A non-numeric value (e.g. 'abc') yields NaN, which slips past the
		// `<= 0` check (every NaN comparison is false) and would schedule a
		// setTimeout(NaN) busy loop. Fall back to the default.
		logger.warn?.(
			`Invalid storage.transactionLog.coolingInterval "${configured}"; using default ${DEFAULT_COOLING_INTERVAL}ms`
		);
		interval = DEFAULT_COOLING_INTERVAL;
	}
	if (interval <= 0) {
		logger.debug?.('Transaction log cooling disabled (storage.transactionLog.coolingInterval <= 0)');
		return;
	}
	logger.debug?.(`Transaction log cooling enabled (every ${interval}ms)`);
	scheduleCooling(interval);
}

/**
 * Test seam: override the cooling function (pass undefined to simulate an older
 * binding) and clear any running timer so each test starts from a known state.
 */
export function setCoolingFunctionForTests(fn?: () => { maps: number; bytes: number }): void {
	cool = fn;
	if (coolingTimer) {
		clearTimeout(coolingTimer);
		coolingTimer = undefined;
	}
}
