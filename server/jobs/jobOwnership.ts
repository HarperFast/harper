'use strict';

import { getDatabases } from '../../resources/databases.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import log from '../../utility/logging/harper_logger.ts';
import * as manageThreads from '../threads/manageThreads.js';
import { updateJob } from './jobs.ts';

/**
 * Ownership is the thread fabric's process incarnation rather than a pid, because pids are reused and a
 * reused pid would make a dead job look alive. It is minted once on the main thread and carried to every
 * worker in `workerData`, so all threads of one Harper process agree on it while any restart produces a
 * new one. The pid rides along for diagnostics only.
 */
export const JOB_OWNER_INSTANCE_ID: string | undefined = manageThreads.processIncarnation;

/** Stripped from `get_job` responses. */
export const JOB_OWNER_ATTRIBUTES = ['owner_instance', 'owner_pid'] as const;

const UNFINISHED_JOB_STATUSES = [hdbTerms.JOB_STATUS_ENUM.CREATED, hdbTerms.JOB_STATUS_ENUM.IN_PROGRESS];

export function stampJobOwner(job: any): void {
	if (job == null || typeof job !== 'object') return;
	job.owner_instance = JOB_OWNER_INSTANCE_ID;
	job.owner_pid = process.pid;
}

let reconciliation: Promise<number> | undefined;

/**
 * Run the sweep at most once for the lifetime of this process.
 *
 * `loadRootComponents` re-runs on every root component reload, and the sweep walks retained job history
 * once per unfinished status. A row this process owns is never settled, and no other process can add a
 * row that this one owns, so every pass after the first is cost with no possible finding.
 *
 * A failed sweep stays failed: the per-row failures are already handled inside, so a rejection here means
 * something systemic that a reload will not have fixed.
 */
export function reconcileInterruptedJobsOnce(): Promise<number> {
	return (reconciliation ??= reconcileInterruptedJobs());
}

/**
 * Settle every job row left unfinished by a process that is no longer running, and report how many were
 * settled.
 *
 * Safe to call more than once: a row this process owns is skipped, and a row it does not own is moved to
 * a terminal status, so a second pass finds nothing. Boot is the only place it needs to run, because a
 * row owned by a live process is by definition still someone's responsibility.
 *
 * Interrupted rows are reported as ERROR rather than a new status: every consumer of `get_job` already
 * handles ERROR, and the distinction lives in the message.
 */
export async function reconcileInterruptedJobs(): Promise<number> {
	// A thread with no incarnation of its own cannot tell a dead owner from a live one, so it settles
	// nothing rather than declaring a running job dead. The main thread always mints one.
	if (JOB_OWNER_INSTANCE_ID == null) return 0;

	const jobTable = (getDatabases() as any).system?.[hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
	if (!jobTable) return 0;

	// Collect before writing: the search walks the `status` attribute these updates change.
	const interrupted: Array<{ id: any; owner_pid: any }> = [];
	for (const status of UNFINISHED_JOB_STATUSES) {
		for await (const job of jobTable.search([{ attribute: 'status', value: status }])) {
			if (job.owner_instance !== JOB_OWNER_INSTANCE_ID) interrupted.push({ id: job.id, owner_pid: job.owner_pid });
		}
	}

	let settled = 0;
	for (const { id, owner_pid } of interrupted) {
		const owner = owner_pid == null ? 'an earlier Harper process' : `Harper process ${owner_pid}`;
		try {
			await updateJob({
				id,
				status: hdbTerms.JOB_STATUS_ENUM.ERROR,
				message: `Job was interrupted: ${owner} exited before it finished. Rerun the operation.`,
			});
			settled++;
		} catch (error) {
			log.error(`Could not settle interrupted job ${id}`, error);
		}
	}
	if (settled > 0) log.warn(`Settled ${settled} job(s) left unfinished by a Harper process that is no longer running`);
	return settled;
}
