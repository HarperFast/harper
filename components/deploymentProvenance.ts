import { basename } from 'node:path';

/** Rides the rename that makes a tree live, so it is never stale. Only an id: the tree is the component's to write. */
export const DEPLOYMENT_PROVENANCE_FILE = '.harper-deployment.json';

const DEPLOYMENT_PROVENANCE_VERSION = 1;

export type DeploymentProvenance = {
	deploymentId: string;
	/**
	 * The build recorded itself as `.deploy-staging/<id>`. A boot install's lifecycle token is a UUID too, so without
	 * this a tree whose record is gone cannot be told from one nothing ever described.
	 */
	described: boolean;
};

export function formatDeploymentProvenance(component: string, deploymentId: string, described = false): string {
	return JSON.stringify(
		described
			? { v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId, described }
			: { v: DEPLOYMENT_PROVENANCE_VERSION, component, deploymentId }
	);
}

export function parseDeploymentProvenanceRecord(raw: string, component: string): DeploymentProvenance | undefined {
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed?.v !== DEPLOYMENT_PROVENANCE_VERSION || parsed.component !== component) return undefined;
	const deploymentId = parsed.deploymentId;
	// A single path segment that cannot name a claim in progress or any other dot-prefixed staging entry.
	if (
		typeof deploymentId !== 'string' ||
		deploymentId.length === 0 ||
		deploymentId !== basename(deploymentId) ||
		deploymentId.startsWith('.')
	) {
		return undefined;
	}
	return { deploymentId, described: parsed.described === true };
}

export function parseDeploymentProvenance(raw: string, component: string): string | undefined {
	return parseDeploymentProvenanceRecord(raw, component)?.deploymentId;
}
