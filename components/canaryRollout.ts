import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { getConfigPath } from '../config/configUtils.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import logger, { errorForLog } from '../utility/logging/harper_logger.ts';
import {
	certificationRequest,
	certificationRollout,
	processIncarnation,
	setCertificationHandler,
} from '../server/threads/manageThreads.js';
import { Application, prepareApplication, withSettledComponent, type ActivationCertification } from './Application.ts';
import {
	liveDeploymentId,
	readCertificationRecord,
	removeCertificationRecord,
	writeCertificationRecord,
	type CertificationRecord,
} from './releaseCertification.ts';

export type CertificationDecision = {
	status: 'certified' | 'rejected' | 'uncertified' | 'withdrawn' | 'interrupted';
	reason?: string;
	failures?: { key: string; name: string; message: string; stack?: string }[];
	/** The release put back in a rejected one's place, or `null` when there was none to put back. */
	restored?: string | null;
	/** A rejected release still live here, which every thread now refuses to load. */
	failedClosed?: boolean;
	recordError?: string;
};

type GateCertification = { component: string; deploymentId: string; decision?: CertificationDecision };

function componentsRootDirPath(): string {
	return getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
}

function recordFields(record: CertificationRecord) {
	return {
		component: record.component,
		deploymentId: record.deploymentId,
		previous: record.previous,
		wasAbsent: record.wasAbsent,
		state: record.state,
		incarnation: record.incarnation,
		reason: record.reason,
	};
}

/**
 * Put back the release a rejected one displaced: step 6's activation of the kept predecessor, refused unless the
 * rejected release is still the live one. Without a predecessor the rejected release stays live and fails closed.
 */
async function restoreRejectedRelease(
	component: string,
	deploymentId: string,
	previous: string | null
): Promise<Pick<CertificationDecision, 'restored' | 'failedClosed' | 'reason'>> {
	if (!previous) return { restored: null, failedClosed: true };
	try {
		await prepareApplication(new Application({ name: component }), {
			mode: 'activate',
			artifactId: previous,
			onlyIfLive: deploymentId,
		});
	} catch (error) {
		// A publish that failed after the swap still put the predecessor live; anything else did not.
		if ((await liveDeploymentId(componentsRootDirPath(), component).catch(() => undefined)) !== previous) {
			logger.error(
				`Could not restore ${component} to deployment ${previous} after release ${deploymentId} was rejected; ` +
					`${component} stays failed closed:`,
				errorForLog(error as Error)
			);
			return { restored: null, failedClosed: true };
		}
	}
	await removeCertificationRecord(componentsRootDirPath(), deploymentId);
	return { restored: previous, failedClosed: false };
}

/** The refusal is durable before anything moves, so a failed restore still leaves the release failed closed. */
async function rejectRelease(
	record: CertificationRecord,
	reason: string
): Promise<Pick<CertificationDecision, 'restored' | 'failedClosed'>> {
	if (record.state !== 'rejected') {
		await writeCertificationRecord(componentsRootDirPath(), {
			...recordFields(record),
			state: 'rejected',
			incarnation: processIncarnation,
			reason,
		});
	}
	return restoreRejectedRelease(record.component, record.deploymentId, record.previous);
}

export async function recordCertificationDecision(
	certification: GateCertification,
	decision: CertificationDecision
): Promise<CertificationDecision> {
	const record = await readCertificationRecord(componentsRootDirPath(), certification.deploymentId);
	if (!record) return decision;
	if (decision.status === 'certified') {
		await writeCertificationRecord(componentsRootDirPath(), { ...recordFields(record), state: 'certified' });
		return decision;
	}
	if (decision.status === 'uncertified') {
		await removeCertificationRecord(componentsRootDirPath(), certification.deploymentId);
		return decision;
	}
	// An undecided release does not stay live: an interrupted certification restores as a rejection does, which is
	// also what the next boot would do with the record it left pending.
	if (decision.status === 'rejected' || decision.status === 'interrupted') {
		const reason =
			decision.reason ??
			(decision.status === 'rejected' ? 'its canary rejected it' : 'it was interrupted before its canary decided');
		logger.error(
			`Release ${certification.deploymentId} of ${certification.component} was ` +
				`${decision.status === 'rejected' ? 'rejected' : 'not certified'}: ${reason}`
		);
		return { ...decision, ...(await rejectRelease(record, reason)) };
	}
	return decision;
}

/**
 * The rollout ended. A refused release keeps whatever record its decision left: `rejected`, or still `pending` where
 * even that could not be written, which the next boot settles.
 */
export async function closeCertification(certification: GateCertification): Promise<void> {
	const status = certification.decision?.status;
	if (status === 'rejected' || status === 'interrupted') return;
	const record = await readCertificationRecord(componentsRootDirPath(), certification.deploymentId).catch(
		() => undefined
	);
	if (record && record.state !== 'rejected') {
		await removeCertificationRecord(componentsRootDirPath(), certification.deploymentId);
	}
}

/** The requester died between arming and telling main the swap committed: the tree on disk says which happened. */
export async function resolveArmedCertification(certification: GateCertification): Promise<'committed' | 'withdrawn'> {
	return withSettledComponent(certification.component, async () => {
		const live = await liveDeploymentId(componentsRootDirPath(), certification.component);
		if (live === certification.deploymentId) return 'committed';
		await removeCertificationRecord(componentsRootDirPath(), certification.deploymentId).catch(() => {});
		return 'withdrawn';
	});
}

if (isMainThread) {
	setCertificationHandler({
		decide: recordCertificationDecision,
		complete: closeCertification,
		resolveArmed: resolveArmedCertification,
	});
}

/**
 * Main, at boot, after interrupted activations are settled and before `installApplications()`: a release whose
 * decision a previous process did not live to make is rejected, and a rejected one whose restore did not land is
 * restored again. A record whose release is no longer live is removed.
 */
export async function resolveInterruptedCertifications(componentsRoot = componentsRootDirPath()): Promise<void> {
	let entries;
	try {
		entries = await readdir(join(componentsRoot, '.deploy-staging'), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		let record: CertificationRecord | undefined;
		try {
			record = await readCertificationRecord(componentsRoot, entry.name);
		} catch (error) {
			logger.error(
				`Leaving an unreadable certification record in deployment ${entry.name}:`,
				errorForLog(error as Error)
			);
			continue;
		}
		if (!record || record.incarnation === processIncarnation) continue;
		try {
			const live = await liveDeploymentId(componentsRoot, record.component);
			if (live !== record.deploymentId) {
				await removeCertificationRecord(componentsRoot, record.deploymentId);
			} else if (record.state === 'certified') {
				await removeCertificationRecord(componentsRoot, record.deploymentId);
			} else if (record.state === 'rejected' && !record.previous) {
				continue;
			} else {
				const reason =
					record.state === 'pending' ? 'the process ended before its canary decided' : (record.reason ?? 'rejected');
				const outcome = await rejectRelease(record, reason);
				logger.error(
					`Release ${record.deploymentId} of ${record.component} is not certified (${reason}); ` +
						(outcome.restored ? `restored deployment ${outcome.restored}` : 'it stays failed closed')
				);
			}
		} catch (error) {
			logger.error(
				`Could not resolve the certification of release ${record.deploymentId} of ${record.component}:`,
				errorForLog(error as Error)
			);
		}
	}
}

export type DeployCertification = ActivationCertification & {
	readonly armed: boolean;
	readonly unavailableReason: string | undefined;
	decision(): Promise<CertificationDecision | undefined>;
	/** Have main decide the release interrupted: this worker is being retired before it could be decided. */
	interrupt(): Promise<boolean>;
	rollout(onProgress?: (untilMs?: number) => void): Promise<any>;
	release(): Promise<void>;
};

export function deployCertification(spec: {
	component: string;
	deploymentId: string;
	/** An isolation flip moves the release to a worker no restart has started yet, so it is not certified. */
	eligible: () => boolean;
	isolated: () => boolean;
	scope: () => string | undefined;
}): DeployCertification {
	let armed = false;
	let joined = false;
	let unavailableReason: string | undefined;
	const identity = () => ({ component: spec.component, deploymentId: spec.deploymentId });
	return {
		get armed() {
			return armed;
		},
		get unavailableReason() {
			return unavailableReason;
		},
		async arm() {
			if (!spec.eligible()) {
				unavailableReason = 'ineligible';
				return false;
			}
			const result = await certificationRequest('arm', {
				...identity(),
				isolated: spec.isolated(),
				scope: spec.scope(),
			});
			armed = Boolean(result?.armed);
			if (armed) return true;
			unavailableReason = result?.reason;
			if (unavailableReason === 'busy' || unavailableReason === 'in-flight') {
				throw new ClientError(
					`Cannot deploy ${spec.component} while another release of it is being certified on this node`,
					409
				);
			}
			return false;
		},
		async commit() {
			await certificationRequest('commit', identity());
		},
		async withdraw() {
			armed = false;
			await certificationRequest('withdraw', identity());
		},
		async join() {
			joined = (await certificationRequest('join', identity())) === true;
			return joined;
		},
		decision: () => certificationRequest('decision', identity()),
		interrupt: () =>
			armed
				? certificationRequest('interrupt', identity()).then(
						(done) => done === true,
						() => false
					)
				: Promise.resolve(false),
		rollout: (onProgress) =>
			isMainThread ? certificationRollout(spec.component, spec.deploymentId, onProgress) : Promise.resolve(undefined),
		// Only the deploy that armed the release is its requester; one that joined its decision only leaves it.
		release: () =>
			armed || joined
				? certificationRequest(armed ? 'release' : 'leave', identity()).catch(() => {})
				: Promise.resolve(),
	};
}
