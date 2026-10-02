import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isUnsupportedSyncError } from '../utility/fsync.ts';
import { DEPLOYMENT_PROVENANCE_FILE, parseDeploymentProvenance } from './deploymentProvenance.ts';

/**
 * A release activated for certification carries this record in its deployment directory from before its swap
 * until its canary decides: `pending` until then, `certified` while the rest of its rollout runs, `rejected` once
 * refused. A `rejected` record left on a live release fails that component closed on every thread.
 */
export const CERTIFICATION_RECORD_FILE = '.certification.json';
const DEPLOY_STAGING_DIR = '.deploy-staging';
const CANDIDATE_COMPONENT_FILE = '.component';
const CERTIFICATION_RECORD_VERSION = 1;
const CERTIFICATION_STATES = new Set(['pending', 'certified', 'rejected']);

export type CertificationState = 'pending' | 'certified' | 'rejected';

export type CertificationRecord = {
	v: typeof CERTIFICATION_RECORD_VERSION;
	component: string;
	deploymentId: string;
	/** The id the release this activation displaces is kept under, when it is kept. */
	previous: string | null;
	/** Nothing was live before this activation. */
	wasAbsent: boolean;
	state: CertificationState;
	/** The process that owns the decision; a record from any other incarnation is resolved at boot. */
	incarnation: string;
	at: number;
	reason?: string;
};

export type NewCertificationRecord = Omit<CertificationRecord, 'v' | 'at'>;

function isPathSegment(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value === basename(value) && !value.startsWith('.');
}

function stagingRoot(componentsRootDirPath: string): string {
	return join(componentsRootDirPath, DEPLOY_STAGING_DIR);
}

export function certificationRecordPath(componentsRootDirPath: string, deploymentId: string): string {
	if (!isPathSegment(deploymentId)) throw new Error(`Invalid deployment id ${JSON.stringify(deploymentId)}`);
	return join(stagingRoot(componentsRootDirPath), deploymentId, CERTIFICATION_RECORD_FILE);
}

async function syncDirectory(dirPath: string): Promise<void> {
	let handle;
	try {
		handle = await open(dirPath, 'r');
	} catch (error) {
		if (isUnsupportedSyncError(error) || (error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedSyncError(error)) throw error;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Replaces the record whole: the final name never holds a partial one. */
export async function writeCertificationRecord(
	componentsRootDirPath: string,
	record: NewCertificationRecord
): Promise<CertificationRecord> {
	const complete: CertificationRecord = { v: CERTIFICATION_RECORD_VERSION, ...record, at: Date.now() };
	const recordPath = certificationRecordPath(componentsRootDirPath, complete.deploymentId);
	const tempPath = `${recordPath}.partial-${process.pid}-${randomUUID()}`;
	const handle = await open(tempPath, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(complete), 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tempPath, recordPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
	await syncDirectory(dirname(recordPath));
	return complete;
}

export async function removeCertificationRecord(componentsRootDirPath: string, deploymentId: string): Promise<void> {
	const recordPath = certificationRecordPath(componentsRootDirPath, deploymentId);
	// A record left behind fences its component, and a scanner holding the file briefly refuses its removal on Windows.
	await rm(recordPath, { force: true, maxRetries: 5, retryDelay: 100 });
	await syncDirectory(dirname(recordPath));
}

/** Absent is `undefined`; a record that exists but cannot be read or is malformed throws. */
export async function readCertificationRecord(
	componentsRootDirPath: string,
	deploymentId: string
): Promise<CertificationRecord | undefined> {
	const recordPath = certificationRecordPath(componentsRootDirPath, deploymentId);
	let raw: string;
	try {
		raw = await readFile(recordPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Certification record ${recordPath} could not be parsed: ${(error as Error).message}`);
	}
	if (
		parsed?.v !== CERTIFICATION_RECORD_VERSION ||
		!isPathSegment(parsed.component) ||
		parsed.deploymentId !== deploymentId ||
		!CERTIFICATION_STATES.has(parsed.state) ||
		!(parsed.previous === null || isPathSegment(parsed.previous)) ||
		typeof parsed.wasAbsent !== 'boolean' ||
		typeof parsed.incarnation !== 'string' ||
		typeof parsed.at !== 'number'
	) {
		throw new Error(`Certification record ${recordPath} is not a certification record this build can read`);
	}
	return parsed as CertificationRecord;
}

/** The deployment id the component's live tree carries. A link or an unmarked tree has none. */
export async function liveDeploymentId(componentsRootDirPath: string, component: string): Promise<string | undefined> {
	const treePath = join(componentsRootDirPath, component);
	const tree = await lstat(treePath).catch((error: NodeJS.ErrnoException) => {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	});
	if (!tree?.isDirectory()) return undefined;
	const raw = await readFile(join(treePath, DEPLOYMENT_PROVENANCE_FILE), 'utf8').catch(
		(error: NodeJS.ErrnoException) => {
			if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return undefined;
			throw error;
		}
	);
	return raw === undefined ? undefined : parseDeploymentProvenance(raw, component);
}

export type LiveCertification =
	{ deploymentId: string; record: CertificationRecord } | { deploymentId: string; unreadable: Error };

/** The record of the release that is live now, if that release has one. */
export async function liveCertification(
	componentsRootDirPath: string,
	component: string
): Promise<LiveCertification | undefined> {
	const deploymentId = await liveDeploymentId(componentsRootDirPath, component);
	if (deploymentId === undefined) return undefined;
	try {
		const record = await readCertificationRecord(componentsRootDirPath, deploymentId);
		if (!record) return undefined;
		if (record.component !== component) {
			return {
				deploymentId,
				unreadable: new Error(`Certification record of deployment ${deploymentId} names '${record.component}'`),
			};
		}
		return { deploymentId, record };
	} catch (error) {
		return { deploymentId, unreadable: error instanceof Error ? error : new Error(String(error)) };
	}
}

/**
 * Why the live release must not run, if it must not. `incarnation` is this process's: its own open decisions are in
 * flight, while one a dead process left open is a release nobody decided, which recovery could not settle either.
 */
export function rejectionReason(live: LiveCertification, incarnation: string): string | undefined {
	if ('unreadable' in live) return `its certification record cannot be read: ${live.unreadable.message}`;
	if (live.record.state === 'rejected') return live.record.reason ?? 'its canary rejected it';
	if (live.record.state === 'pending' && live.record.incarnation !== incarnation) {
		return 'its certification was never decided';
	}
	return undefined;
}

export class RejectedReleaseError extends Error {
	constructor(component: string, deploymentId: string, reason: string) {
		super(`Not loading ${component}: its release ${deploymentId} is not certified to run on this node, ${reason}`);
		this.name = 'RejectedReleaseError';
	}
}

/**
 * Every component whose live release must not load: one its canary rejected, one a dead process left undecided, or
 * one whose record cannot be read — an unreadable decision is never permission to run. Read-only, so any thread
 * reaches the same answer.
 */
export async function failClosedReleases(
	componentsRootDirPath: string,
	incarnation: string
): Promise<Map<string, Error>> {
	const failClosed = new Map<string, Error>();
	let entries;
	try {
		entries = await readdir(stagingRoot(componentsRootDirPath), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failClosed;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !isPathSegment(entry.name)) continue;
		const deploymentDirPath = join(stagingRoot(componentsRootDirPath), entry.name);
		const present = await lstat(join(deploymentDirPath, CERTIFICATION_RECORD_FILE)).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error?.code === 'ENOENT') return false;
				throw error;
			}
		);
		if (!present) continue;
		const owner = await readFile(join(deploymentDirPath, CANDIDATE_COMPONENT_FILE), 'utf8').then(
			(named) => named.trim(),
			() => undefined
		);
		if (!isPathSegment(owner) || failClosed.has(owner)) continue;
		const live = await liveCertification(componentsRootDirPath, owner).catch((error) => ({
			deploymentId: entry.name,
			unreadable: error instanceof Error ? error : new Error(String(error)),
		}));
		if (!live || live.deploymentId !== entry.name) continue;
		const reason = rejectionReason(live, incarnation);
		if (reason) failClosed.set(owner, new RejectedReleaseError(owner, entry.name, reason));
	}
	return failClosed;
}

/**
 * The predecessors a component's certification records name, which retention must keep while any decision is open
 * or refused — `undefined` when one of its records cannot be read, since then nothing of that component may be
 * pruned.
 */
export async function certificationPinsOf(
	componentsRootDirPath: string,
	component: string
): Promise<string[] | undefined> {
	let entries;
	try {
		entries = await readdir(stagingRoot(componentsRootDirPath), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const pins: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isPathSegment(entry.name)) continue;
		const deploymentDirPath = join(stagingRoot(componentsRootDirPath), entry.name);
		const owner = await readFile(join(deploymentDirPath, CANDIDATE_COMPONENT_FILE), 'utf8').then(
			(named) => named.trim(),
			() => undefined
		);
		if (owner !== component) continue;
		try {
			const record = await readCertificationRecord(componentsRootDirPath, entry.name);
			if (record?.previous) pins.push(record.previous);
		} catch {
			return undefined;
		}
	}
	return pins;
}
