'use strict';

import { getDatabases } from '../../resources/databases.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import log from '../../utility/logging/harper_logger.ts';
import * as manageThreads from '../threads/manageThreads.js';
import { updateJob } from './jobs.ts';

/**
 * The thread fabric's process incarnation, not a pid: pids are reused, and a reused pid would make a
 * dead job look alive. Every thread of one Harper process carries the same value, and any restart
 * produces a new one. `undefined` on a thread started without one.
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
 * Reconcile at most once per process. `loadRootComponents` re-runs on every root component reload, and
 * no process can add a row that this one owns, so every pass after a *complete* one could only find
 * nothing. A pass that left any row unsettled clears the memo instead, so the next reload retries the
 * stragglers — the recovery this exists for must not be lost to one transient write failure.
 */
export function reconcileInterruptedJobsOnce(): Promise<number> {
	return (reconciliation ??= reconcileInterruptedJobs().catch((error) => {
		reconciliation = undefined;
		throw error;
	}));
}

/**
 * Settle every job row left unfinished by a process that is no longer running, and report how many were
 * settled. Callers need not await it: the rows are chosen before the first write, so a job created while
 * it runs is this process's and out of scope by construction.
 *
 * Settled rows are reported as ERROR rather than a new status, because every consumer of `get_job`
 * already handles ERROR.
 */
export async function reconcileInterruptedJobs(): Promise<number> {
	// A thread with no incarnation cannot tell a dead owner from a live one, so it settles nothing rather
	// than declaring a running job dead. The main thread always has one.
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
	let unsettled = 0;
	for (const { id, owner_pid } of interrupted) {
		const owner = owner_pid == null ? 'an earlier Harper process' : `Harper process ${owner_pid}`;
		try {
			// Deliberately not "rerun it": the job may have applied some of its effects before it died, and
			// nothing here can tell how far it got.
			await updateJob({
				id,
				status: hdbTerms.JOB_STATUS_ENUM.ERROR,
				message: `Job was interrupted: ${owner} exited before it finished. Its outcome is unknown — check for partial effects before running the operation again.`,
			});
			settled++;
		} catch (error) {
			// Keep going: one unwritable row must not strand the rest.
			unsettled++;
			log.error(`Could not settle interrupted job ${id}`, error);
		}
	}
	if (settled > 0) log.warn(`Settled ${settled} job(s) left unfinished by a Harper process that is no longer running`);
	// Reported as a failure so the pass is not memoized as complete while rows are still stuck.
	if (unsettled > 0) throw new Error(`Could not settle ${unsettled} of ${interrupted.length} interrupted job(s)`);
	return settled;
}
