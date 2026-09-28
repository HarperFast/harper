import { basename } from 'node:path';

/**
 * The deployment id of the build that made a component tree, recorded at the top of the tree itself. It rides the
 * rename that makes the tree live, so it is never stale: anything else that replaces the directory replaces it too.
 * The name is reserved in a component's top-level directory, and only an id is recorded — the tree is the
 * component's own to write, so nothing that is published on activation may come from here.
 */
export const DEPLOYMENT_PROVENANCE_FILE = '.harper-deployment.json';

const DEPLOYMENT_PROVENANCE_VERSION = 1;

export function formatDeploymentProvenance(component: string, deploymentId: string): string {
	return JSON.stringify({ v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId });
}

/** The deployment id a marker records for `component`, or `undefined` when it records no usable one. */
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
