// Expiry for the payload tarballs failed deploys keep. A successful deploy drops a large payload once every
// peer has installed it (deployComponent); a failed one keeps it, since that tarball is what an operator retries or
// debugs with. Kept forever, a retried rollout filled a tenant's quota with copies of one bundle, so each project now
// keeps only its newest failed payloads, and none past an age, beyond the newest one it always keeps.

import { hostname } from 'node:os';
import { databases } from '../resources/databases.ts';
import { getConfigValue } from '../config/configUtils.ts';
import { convertToMS } from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import { logger } from '../utility/logging/logger.ts';

const DEFAULT_FAILED_MAX_AGE = '7d';
const DEFAULT_FAILED_MAX_COUNT = 2;

/** `0` turns a bound off; anything that is not a usable value falls back to the default rather than to "drop all". */
export function failedPayloadRetention(): { maxAgeMs: number; maxCount: number } {
	const age = getConfigValue(terms.CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXAGE);
	const usableAge = typeof age === 'number' || (typeof age === 'string' && DURATION.test(age.trim()));
	const maxAgeMs = convertToMS(usableAge ? age : DEFAULT_FAILED_MAX_AGE);
	const configuredCount = getConfigValue(terms.CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXCOUNT);
	// Number('') and Number(null) are 0, which would turn the bound off rather than leave it at its default.
	const count = isSetting(configuredCount) ? Number(configuredCount) : NaN;
	return {
		maxAgeMs: Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : convertToMS(DEFAULT_FAILED_MAX_AGE),
		maxCount: Number.isInteger(count) && count >= 0 ? count : DEFAULT_FAILED_MAX_COUNT,
	};
}

function isSetting(value: unknown): value is string | number {
	return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
}

// The units convertToMS knows; it reads any other suffix as seconds, so `7days` would expire payloads after 7s.
const DURATION = /^\d+(\.\d+)?[yMdDhHm]?$/;

/**
 * Drop the payloads of failed deploys beyond the bounds, keeping each row's metadata and `event_log`, as
 * `delete_deployment_payload` does: the row is written with `payload_blob: null`, which unlinks the file here and
 * replicates so peers drop their copies. Rows are ranked across the cluster but each node drops only the rows it wrote,
 * so each is written once; a row whose node left the cluster keeps its payload. The newest failed payload of each
 * project is always kept. Never throws; returns what it dropped.
 */
export async function sweepFailedPayloads(
	options: { project?: string; now?: number } = {}
): Promise<Array<{ deployment_id: string; freed_bytes: number }>> {
	const dropped: Array<{ deployment_id: string; freed_bytes: number }> = [];
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return dropped;
	const { maxAgeMs, maxCount } = failedPayloadRetention();
	if (maxAgeMs === 0 && maxCount === 0) return dropped;
	const now = options.now ?? Date.now();
	const origin = hostname();
	try {
		const conditions: any[] = [{ attribute: 'status', value: 'failed' }];
		if (options.project) conditions.push({ attribute: 'project', value: options.project });
		const byProject = new Map<string, any[]>();
		for await (const row of table.search(conditions)) {
			if (row?.payload_blob == null) continue;
			let rows = byProject.get(row.project);
			if (!rows) byProject.set(row.project, (rows = []));
			rows.push(row);
		}
		for (const rows of byProject.values()) {
			rows.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
			// Ranked across every node's rows, so the bound is per project, not per origin; each node drops only the rows
			// it wrote, so each row is written once.
			for (const [index, row] of rows.entries()) {
				if (index === 0 || row.origin_node !== origin) continue;
				const tooMany = maxCount > 0 && index >= maxCount;
				const tooOld = maxAgeMs > 0 && now - (row.completed_at ?? row.started_at ?? now) > maxAgeMs;
				if (!tooMany && !tooOld) continue;
				const freedBytes = typeof row.payload_size === 'number' ? row.payload_size : 0;
				await table.put({
					...row,
					payload_blob: null,
					event_log: [
						...(Array.isArray(row.event_log) ? row.event_log : []),
						{
							t: now,
							event: 'payload_dropped',
							data: {
								payload_size: freedBytes,
								reason: 'retention',
								limit: tooMany ? 'failedMaxCount' : 'failedMaxAge',
							},
						},
					],
				});
				dropped.push({ deployment_id: row.deployment_id, freed_bytes: freedBytes });
			}
		}
	} catch (error) {
		logger.warn?.('Failed to expire the payloads of failed deploys', error);
	}
	if (dropped.length > 0) {
		logger.info?.(
			`Dropped the payloads of ${dropped.length} failed deploy(s) beyond deployment.payloadRetention ` +
				`(failedMaxAge, failedMaxCount), freeing ${dropped.reduce((sum, { freed_bytes }) => sum + freed_bytes, 0)} bytes`
		);
	}
	return dropped;
}

let bootSweep: Promise<unknown> | undefined;

/** Once per process, at boot: the age bound expires payloads no later deploy of their project would reach. */
export function sweepFailedPayloadsOnce(): Promise<unknown> {
	bootSweep ??= sweepFailedPayloads();
	return bootSweep;
}
