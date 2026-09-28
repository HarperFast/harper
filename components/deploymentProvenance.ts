import { basename } from 'node:path';

/** Rides the rename that makes a tree live, so it is never stale. Only an id: the tree is the component's to write. */
export const DEPLOYMENT_PROVENANCE_FILE = '.harper-deployment.json';

const DEPLOYMENT_PROVENANCE_VERSION = 1;

export function formatDeploymentProvenance(component: string, deploymentId: string): string {
	return JSON.stringify({ v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId });
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
