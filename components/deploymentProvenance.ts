import { basename } from 'node:path';

/** Rides the rename that makes a tree live, so it is never stale. Only an id: the tree is the component's to write. */
export const DEPLOYMENT_PROVENANCE_FILE = '.harper-deployment.json';

const DEPLOYMENT_PROVENANCE_VERSION = 1;

export interface PreviewMetadata {
	app: string;
	pr: number;
	repository?: string;
	branch?: string;
	sha?: string;
	/** ISO 8601, or epoch milliseconds. */
	expiresAt?: string | number;
	/** The deploying identity's, stamped from its component grant; disabling previews revokes it. */
	generation?: string;
}

/**
 * A preview's metadata rides with its tree's id, so it is the release's own: a restore or an activation of a staged
 * build brings back the metadata that build was deployed with, and a build that was not a preview carries none.
 */
export function formatDeploymentProvenance(component: string, deploymentId: string, preview?: PreviewMetadata): string {
	return JSON.stringify(
		preview
			? { v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId, preview }
			: { v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId }
	);
}

/** The preview metadata of a provenance file that names `component`, or undefined for a release that is not a preview. */
export function parseDeploymentPreview(raw: string, component: string): PreviewMetadata | undefined {
	if (parseDeploymentProvenance(raw, component) === undefined) return undefined;
	const { preview } = JSON.parse(raw);
	return typeof preview === 'object' && preview !== null && !Array.isArray(preview) ? preview : undefined;
}

/** When a preview expires, in epoch milliseconds; undefined when it never does or says so unreadably. */
export function previewExpiresAtMs(preview: PreviewMetadata | undefined): number | undefined {
	const expiresAt = preview?.expiresAt;
	const ms = typeof expiresAt === 'number' ? expiresAt : typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
	return Number.isFinite(ms) ? ms : undefined;
}

export function parseDeploymentProvenance(raw: string, component: string): string | undefined {
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed?.v !== DEPLOYMENT_PROVENANCE_VERSION || parsed.component !== component) return undefined;
	const deploymentId = parsed.deploymentId;
	// A single path segment that cannot name a claim in progress or any other dot-prefixed staging entry.
	return typeof deploymentId === 'string' &&
		deploymentId.length > 0 &&
		deploymentId === basename(deploymentId) &&
		!deploymentId.startsWith('.')
		? deploymentId
		: undefined;
}
