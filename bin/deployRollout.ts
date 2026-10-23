/**
 * `harper deploy restart=rolling` answers once the node it reached has taken the release; the deployment's record
 * says when every other node has. The record replicates, so the wait reads it through whichever node
 * the target resolves to: `get_job` is node-local and a load balancer can route a poll to a node that never had it.
 */

// Each node's turn is a worker restart with its canary's decision, which the server bounds by its restart ceiling.
export const ROLLOUT_WAIT_PER_NODE_MS = 10 * 60 * 1000;

const ENDED_STATUSES = new Set(['success', 'partial', 'failed', 'rolled_back', 'staged']);

export interface RolloutRecord {
	deployment_id?: string;
	status?: string;
	peer_results?: Array<{
		node?: string;
		activation?: { activated?: boolean; certification?: unknown; error?: string };
	}>;
	error?: { message?: string; nodes?: string[] };
}

export interface RolloutWaitOptions {
	/** The whole wait; by default {@link ROLLOUT_WAIT_PER_NODE_MS} for each node the record lists. */
	timeoutMs?: number;
	report?: (line: string) => void;
	initialIntervalMs?: number;
	maxIntervalMs?: number;
}

export interface RolloutOutcome {
	record?: RolloutRecord;
	timedOut: boolean;
	/** Why the rollout did not end with every node taking the release; undefined when it did. */
	failure?: string;
}

/**
 * Follow a rolling deploy's record until it ends, reporting each node's outcome as it lands. A read
 * that fails is retried until the deadline, except a refusal (401/403), which no retry fixes.
 */
export async function awaitRollout(
	deploymentId: string,
	getDeployment: (deploymentId: string, timeoutMs: number) => Promise<RolloutRecord>,
	options: RolloutWaitOptions = {}
): Promise<RolloutOutcome> {
	const report = options.report ?? ((line: string) => console.error(line));
	const maxIntervalMs = options.maxIntervalMs ?? 10_000;
	let intervalMs = options.initialIntervalMs ?? 1000;
	const started = Date.now();
	const deadlineFor = (record?: RolloutRecord) =>
		started + (options.timeoutMs ?? Math.max(1, record?.peer_results?.length ?? 0) * ROLLOUT_WAIT_PER_NODE_MS);
	let deadline = deadlineFor();
	const reported = new Set<string>();
	let record: RolloutRecord | undefined;
	let lastError: Error | undefined;
	report(`Waiting for the other nodes to take deployment ${deploymentId}...`);
	while (true) {
		try {
			record = await getDeployment(deploymentId, Math.max(1, deadline - Date.now()));
			lastError = undefined;
		} catch (error) {
			const { statusCode } = error as { statusCode?: number };
			if (statusCode === 401 || statusCode === 403) {
				// An expired token answers 403 as well as a missing grant does.
				const remedy =
					'Grant the role get_deployment, or, if the token expired (an exchanged CI token lasts an hour), follow the ' +
					'record with get_deployment';
				return {
					record,
					timedOut: false,
					failure:
						`could not read deployment ${deploymentId} to follow its rollout: ${error.message}. ${remedy}, ` +
						`or pass wait=false to stop once this node has taken the release`,
				};
			}
			lastError = error;
		}
		for (const peer of record?.peer_results ?? []) {
			if (!peer?.node || !peer.activation || reported.has(peer.node)) continue;
			reported.add(peer.node);
			const { activated, certification, error } = peer.activation;
			report(
				activated
					? `  ${peer.node}: took the release${certification ? ` (${certification})` : ''}`
					: `  ${peer.node}: did not take the release: ${error ?? 'unknown error'}`
			);
		}
		// Only an ending ends the wait: a node whose copy of the row lags still shows the origin's earlier status.
		if (record && ENDED_STATUSES.has(record.status)) return { record, timedOut: false, failure: failureOf(record) };
		// A first read that failed knew no nodes; the bound grows once a read says how many there are.
		deadline = Math.max(deadline, deadlineFor(record));
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			const waiting = (record?.peer_results ?? []).filter((peer) => peer?.node && !peer.activation);
			return {
				record,
				timedOut: true,
				failure:
					`timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for deployment ${deploymentId} to ` +
					`roll out` +
					(waiting.length ? `; not yet taken on ${waiting.map((peer) => peer.node).join(', ')}` : '') +
					(lastError ? ` (last read failed: ${lastError.message})` : ''),
			};
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
		intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
	}
}

function failureOf(record: RolloutRecord): string | undefined {
	if (record.status === 'success') return undefined;
	return record.error?.message ?? `deployment ${record.deployment_id} ended ${record.status}`;
}

/** The part of a rollout's record the CLI prints beside the deploy's own response. */
export function summarizeRollout(outcome: RolloutOutcome): Record<string, unknown> {
	const { record } = outcome;
	return {
		status: outcome.timedOut ? 'timed_out' : record?.status,
		nodes: (record?.peer_results ?? []).map((peer) => ({ node: peer?.node, ...peer?.activation })),
		...(record?.error && { error: record.error }),
	};
}
