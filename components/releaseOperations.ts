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
	fenced?: true;
}

/**
 * `fence`, when given, runs on this node before it reads, and the request carries the same operation to every peer, so
 * each answer says whether that node ran its own. A node that cannot fence, or cannot read a component `strictFor`
 * accepts or the list of them, answers with an error rather than a census that looks complete.
 */
export async function handleListReleases(
	req: ListReleasesRequest = {},
	{
		timeoutMs,
		fence,
		strictFor,
	}: { timeoutMs?: number; fence?: () => Promise<void>; strictFor?: (project: string) => boolean } = {}
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
	let local: NodeReleases;
	try {
		await fence?.();
		local = {
			node: getThisNodeName(),
			components: await releasesOnThisNode(project, strictFor),
			...(fence && { fenced: true as const }),
		};
	} catch (error) {
		if (!fence) throw error;
		local = { node: getThisNodeName(), error: (error as Error).message };
	}
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
			const error = answer?.error ?? 'it answered without a list of releases';
			nodes.push({ node: peer?.node ?? answer?.node, error });
			continue;
		}
		nodes.push({
			node: peer?.node ?? answer?.node,
			components: answer.components,
			...(answer.fenced === true && { fenced: true as const }),
		});
	}
	return { nodes };
}

async function releasesOnThisNode(
	project: string | undefined,
	strictFor?: (project: string) => boolean
): Promise<ComponentReleases[]> {
	const componentsRoot = getConfigPath(terms.CONFIG_PARAMS.COMPONENTSROOT) as string;
	const names =
		project === undefined ? await componentsWithReleases(componentsRoot, strictFor !== undefined) : [project];
	const components: ComponentReleases[] = [];
	for (const name of names) {
		const releases = await keptReleasesOf(componentsRoot, name);
		const live = liveDeploymentIdOf(componentsRoot, name);
		const deploymentId = strictFor?.(name) ? await live : await live.catch(() => undefined);
		if (project === undefined && !deploymentId && releases.length === 0) continue;
		components.push({ project: name, ...(deploymentId && { deployment_id: deploymentId }), releases });
	}
	return components;
}
