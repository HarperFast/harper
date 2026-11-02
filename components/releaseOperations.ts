// `list_releases`: which release is live on each node, and which each node keeps for `deploy_component
// { deployment_id }`. `list_deployments` lists the records the origin wrote; this lists what is on disk.

import { componentsWithReleases, keptReleasesOf, liveDeploymentIdOf, type KeptRelease } from './Application.ts';
import { getConfigPath } from '../config/configUtils.ts';
import { server } from '../server/Server.ts';
import { getThisNodeName } from '../server/nodeName.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

interface ListReleasesRequest {
	operation?: string;
	project?: string;
	replicated?: boolean;
}

interface ComponentReleases {
	project: string;
	/** The id the live tree's provenance marker names; absent for a tree without one. */
	deployment_id?: string;
	releases: KeptRelease[];
}

interface NodeReleases {
	node: string;
	components?: ComponentReleases[];
	error?: string;
}

export async function handleListReleases(
	req: ListReleasesRequest = {},
	{ timeoutMs }: { timeoutMs?: number } = {}
): Promise<NodeReleases | { nodes: NodeReleases[] }> {
	const { project } = req;
	if (project !== undefined && (typeof project !== 'string' || !/^[^./\\][^/\\]*$/.test(project))) {
		throw new ClientError(`'project' must be a component name`);
	}
	// Asked of the other nodes first, so they read while this one does. Settled into a value at once, so a rejection
	// that lands during the local read is never an unhandled one.
	const whenReplicated =
		req.replicated === true
			? server.replication.replicateOperation({ ...req, replicated: true }, { timeoutMs }).then(
					(response) => ({ response }),
					(error) => ({ error })
				)
			: undefined;
	const local: NodeReleases = { node: getThisNodeName(), components: await releasesOnThisNode(project) };
	if (!whenReplicated) return local;
	const settled: { response?: any; error?: unknown } = await whenReplicated;
	if ('error' in settled) throw settled.error;
	const { response } = settled;
	const nodes = [local];
	for (const peer of response?.replicated ?? []) {
		if (peer?.status === 'failed') {
			nodes.push({
				node: peer.node,
				error: String(peer.reason ?? peer.error?.message ?? peer.error ?? 'unknown error'),
			});
			continue;
		}
		const answer = peer?.components ? peer : (peer?.value ?? peer?.body ?? peer);
		if (!Array.isArray(answer?.components)) {
			nodes.push({ node: peer?.node ?? answer?.node, error: 'it answered without a list of releases' });
			continue;
		}
		nodes.push({ node: peer?.node ?? answer?.node, components: answer.components });
	}
	return { nodes };
}

async function releasesOnThisNode(project: string | undefined): Promise<ComponentReleases[]> {
	const componentsRoot = getConfigPath(terms.CONFIG_PARAMS.COMPONENTSROOT) as string;
	const names = project === undefined ? await componentsWithReleases(componentsRoot) : [project];
	const components: ComponentReleases[] = [];
	for (const name of names) {
		const releases = await keptReleasesOf(componentsRoot, name);
		const deploymentId = await liveDeploymentIdOf(componentsRoot, name).catch(() => undefined);
		if (project === undefined && !deploymentId && releases.length === 0) continue;
		components.push({ project: name, ...(deploymentId && { deployment_id: deploymentId }), releases });
	}
	return components;
}
