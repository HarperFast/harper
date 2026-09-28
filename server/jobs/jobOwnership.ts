'use strict';

import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { getDatabases } from '../../resources/databases.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import log from '../../utility/logging/harper_logger.ts';
import { updateJob } from './jobs.ts';

/**
 * Ownership is a per-process id rather than a pid, because pids are reused and a reused pid would
 * make a dead job look alive. It is minted on the main thread and inherited by workers through
 * `process.env`, so every thread of one Harper process agrees on it while any restart produces a
 * new one. The pid rides along for diagnostics only.
 */
const JOB_OWNER_INSTANCE_ENV = 'HARPER_JOB_OWNER_INSTANCE';
if (isMainThread) process.env[JOB_OWNER_INSTANCE_ENV] = randomUUID();
export const JOB_OWNER_INSTANCE_ID = process.env[JOB_OWNER_INSTANCE_ENV] ?? randomUUID();

/** Stripped from `get_job` responses. */
export const JOB_OWNER_ATTRIBUTES = ['owner_instance', 'owner_pid'] as const;

const UNFINISHED_JOB_STATUSES = [hdbTerms.JOB_STATUS_ENUM.CREATED, hdbTerms.JOB_STATUS_ENUM.IN_PROGRESS];

export function stampJobOwner(job: any): void {
	if (job == null || typeof job !== 'object') return;
	job.owner_instance = JOB_OWNER_INSTANCE_ID;
	job.owner_pid = process.pid;
}

function jobTable(): any {
	return (getDatabases() as any).system?.[hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
}

function settle(id: any, interruption: string) {
	return updateJob({
		id,
		status: hdbTerms.JOB_STATUS_ENUM.ERROR,
		message: `Job was interrupted: ${interruption}. Rerun the operation.`,
	});
}

/**
 * Settle every job row left unfinished by a process that is no longer running, and report how many
 * were settled. Idempotent: a row this process owns is skipped, and every other unfinished row
 * becomes terminal.
 */
export async function reconcileInterruptedJobs(): Promise<number> {
	const table = jobTable();
	if (!table) return 0;

	// Collect before writing: the search walks the `status` attribute these updates change.
	const interrupted: Array<{ id: any; owner_pid: any }> = [];
	for (const status of UNFINISHED_JOB_STATUSES) {
		for await (const job of table.search([{ attribute: 'status', value: status }])) {
			if (job.owner_instance !== JOB_OWNER_INSTANCE_ID) interrupted.push({ id: job.id, owner_pid: job.owner_pid });
		}
	}

	let settled = 0;
	for (const { id, owner_pid } of interrupted) {
		const owner = owner_pid == null ? 'an earlier Harper process' : `Harper process ${owner_pid}`;
		try {
			await settle(id, `${owner} exited before it finished`);
			settled++;
		} catch (error) {
			log.error(`Could not settle interrupted job ${id}`, error);
		}
	}
	if (settled > 0) log.warn(`Settled ${settled} job(s) left unfinished by a Harper process that is no longer running`);
	return settled;
}

/** Settle a job abandoned by a worker thread that died inside a live process. See server/DESIGN.md. */
export async function settleAbandonedJob(jobId: any): Promise<boolean> {
	const job = await jobTable()?.get(jobId);
	if (!UNFINISHED_JOB_STATUSES.includes(job?.status)) return false;
	await settle(jobId, 'its worker thread exited before it finished');
	log.warn(`Settled job ${jobId}, whose worker thread exited before it finished`);
	return true;
}
