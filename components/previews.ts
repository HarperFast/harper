/** PR previews' cap and expiry sweep; see components/DESIGN.md, "PR previews record what they came from, and expire". */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfigPath, getConfigValue } from '../config/configUtils.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import {
	DEPLOYMENT_PROVENANCE_FILE,
	parseDeploymentPreview,
	parseDeploymentProvenance,
	previewExpiresAtMs,
	type PreviewMetadata,
} from './deploymentProvenance.ts';
import { deployLifecycle } from './deployLifecycle.ts';
import { withComponentPreparationLock } from './componentPreparationLock.ts';

const logger = harperLogger.forComponent('previews');
const SWEEP_JOB = 'preview-expiry';
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface LocalPreview {
	component: string;
	deploymentId?: string;
	preview: PreviewMetadata;
	/** When its release was built here, which is when its provenance was written. */
	deployedAtMs: number;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== 'number' && typeof value !== 'string') return undefined;
	if (typeof value === 'string' && value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function componentsRootPath(): string {
	return getConfigPath(CONFIG_PARAMS.COMPONENTSROOT) as string;
}

export async function readLocalPreview(
	component: string,
	componentsRoot: string = componentsRootPath()
): Promise<LocalPreview | undefined> {
	const provenancePath = join(componentsRoot, component, DEPLOYMENT_PROVENANCE_FILE);
	const raw = await readFile(provenancePath, 'utf8').catch(() => undefined);
	const preview = raw === undefined ? undefined : parseDeploymentPreview(raw, component);
	if (!preview) return undefined;
	const written = await stat(provenancePath).catch(() => undefined);
	return {
		component,
		deploymentId: parseDeploymentProvenance(raw!, component),
		preview,
		deployedAtMs: written?.mtimeMs ?? 0,
	};
}

export async function listLocalPreviews(componentsRoot: string = componentsRootPath()): Promise<LocalPreview[]> {
	const entries = await readdir(componentsRoot, { withFileTypes: true }).catch(() => []);
	const previews = await Promise.all(
		entries.map((entry) =>
			entry.name.startsWith('.') || !entry.isDirectory() ? undefined : readLocalPreview(entry.name, componentsRoot)
		)
	);
	return previews.filter((live): live is LocalPreview => live !== undefined);
}

/**
 * Refuse a new preview of `app` beyond `deployment.previews.maxPerApplication`, naming the oldest one. A redeploy of
 * a preview that is already live never counts against the cap.
 */
export async function assertPreviewCapacity(
	component: string,
	app: string,
	max: number | undefined = positiveInteger(getConfigValue(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION)),
	previews?: LocalPreview[],
	limitName = 'deployment.previews.maxPerApplication'
): Promise<void> {
	if (max === undefined) return;
	const ofApp = (previews ?? (await listLocalPreviews())).filter((live) => live.preview.app === app);
	if (ofApp.some((live) => live.component === component) || ofApp.length < max) return;
	const oldest = ofApp.reduce((a, b) => (b.deployedAtMs < a.deployedAtMs ? b : a));
	throw new ClientError(
		`Cannot deploy preview '${component}': '${app}' already has ${ofApp.length} preview(s), the most ` +
			`${limitName} allows. The oldest is '${oldest.component}'` +
			(oldest.preview.pr !== undefined ? ` (PR ${oldest.preview.pr})` : '') +
			`; drop it, or another, first.`,
		409
	);
}

/**
 * Swap a preview in only while its application is under its cap, holding one lock per application across the count
 * and the swap, so two previews never both take the last slot. The metadata is the candidate's own, which a staged
 * build's later activation carries too, and `admit` may refuse it, a missing one included, before anything is counted.
 */
export async function admitPreviewActivation(
	component: string,
	candidateDirPath: string,
	activate: () => Promise<void>,
	max: number | undefined = positiveInteger(getConfigValue(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_MAXPERAPPLICATION)),
	componentsRoot: string = componentsRootPath(),
	admit?: (preview: PreviewMetadata | undefined) => void,
	limitName?: string
): Promise<void> {
	if (max === undefined && !admit) return activate();
	const raw = await readFile(join(candidateDirPath, DEPLOYMENT_PROVENANCE_FILE), 'utf8').catch(() => undefined);
	const preview = raw === undefined ? undefined : parseDeploymentPreview(raw, component);
	admit?.(preview);
	if (!preview || max === undefined) return activate();
	await withComponentPreparationLock(
		join(componentsRoot, `.preview-admission-${encodeURIComponent(preview.app)}`),
		async () => {
			await assertPreviewCapacity(component, preview.app, max, await listLocalPreviews(componentsRoot), limitName);
			await activate();
		},
		{ purpose: `preview admission for ${preview.app}` }
	);
}

/**
 * Drop every preview here whose `expiresAt` has passed; returns the components it dropped. Each drop names the release
 * the listing saw, and every node skips it when its live release is another one, so a redeploy that lands first is
 * kept.
 */
export async function sweepExpiredPreviews(
	drop: (component: string, deploymentId: string) => Promise<{ componentRemoved?: boolean } | undefined>,
	now: number = Date.now(),
	previews?: LocalPreview[]
): Promise<string[]> {
	const dropped: string[] = [];
	for (const { component, deploymentId, preview } of previews ?? (await listLocalPreviews())) {
		const expiresAt = previewExpiresAtMs(preview);
		if (expiresAt === undefined || expiresAt > now || deploymentId === undefined) continue;
		try {
			if ((await drop(component, deploymentId))?.componentRemoved === false) continue;
			dropped.push(component);
			logger.info?.(`Dropped preview ${component}: it expired at ${new Date(expiresAt).toISOString()}`);
		} catch (error) {
			logger.error?.(`Could not drop expired preview ${component}:`, error);
		}
	}
	return dropped;
}

/**
 * A replicated drop through the operations API, so every node removes it, and only while its live release is the one
 * that expired. It stops an isolated preview's own worker; a shared preview stays served by the pool until its next
 * restart.
 */
async function dropPreview(component: string, deploymentId: string): Promise<{ componentRemoved?: boolean }> {
	const { server } = await import('../server/Server.ts');
	return server.operation(
		{ operation: 'drop_component', project: component, ifDeploymentId: deploymentId },
		undefined,
		false
	) as Promise<{ componentRemoved?: boolean }>;
}

let sweepRegistered = false;
let registering: Promise<boolean> | undefined;

/**
 * Register the sweep with the cluster scheduler once this node holds a preview: on the application primary worker,
 * at boot and after each deploy. Only then, so a cluster that runs no previews never starts the scheduler's leader
 * election for it. A failed attempt leaves the next one free to try again.
 */
export function ensurePreviewSweep(): Promise<boolean> {
	if (sweepRegistered) return Promise.resolve(true);
	registering ??= registerPreviewSweep().finally(() => {
		registering = undefined;
	});
	return registering;
}

async function registerPreviewSweep(): Promise<boolean> {
	const { isApplicationPrimaryWorker } = await import('../server/threads/manageThreads.ts');
	if (!isApplicationPrimaryWorker(undefined)) return false;
	const { isReadOnlyMode } = await import('../resources/readOnlyMode.ts');
	if (isReadOnlyMode()) return false;
	if ((await listLocalPreviews()).length === 0) return false;
	const { internalJobOwner, registerInternalJobs, startSchedulerEngine } =
		await import('../resources/scheduler/engine.ts');
	registerInternalJobs(SWEEP_JOB, [
		{
			name: 'sweep',
			componentName: internalJobOwner(SWEEP_JOB),
			intervalMs:
				positiveInteger(getConfigValue(CONFIG_PARAMS.DEPLOYMENT_PREVIEWS_SWEEPINTERVAL)) ?? DEFAULT_SWEEP_INTERVAL_MS,
			handler: () => sweepExpiredPreviews(dropPreview),
		},
	]);
	startSchedulerEngine();
	sweepRegistered = true;
	return true;
}

let watching = false;

export function watchForPreviews(): void {
	if (watching) return;
	const register = () =>
		ensurePreviewSweep().catch((error) => logger.error?.('Could not register the preview expiry sweep:', error));
	deployLifecycle.on('deploy:end', () => {
		if (!sweepRegistered) register();
	});
	watching = true;
	register();
}

/** @internal — testing only */
export function resetPreviewSweepForTests(): void {
	sweepRegistered = false;
}
