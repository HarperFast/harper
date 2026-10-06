import { parentPort } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from '../../config/configUtils.ts';
import { CONFIG_PARAMS, ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import { bootVerdictOf, trackBootOutcomes, type BootVerdictOutcome } from '../../components/componentLoader.ts';
import { liveDeploymentId } from '../../components/releaseCertification.ts';

export type HeldStartRequest = { component: string; deploymentId: string };

type ComponentVerdict = {
	component: string;
	outcome: Exclude<BootVerdictOutcome, 'pending'>;
	failures: { key: string; name: string; message: string; stack?: string }[];
	/** The release live when this worker began its load, and when it reported. */
	loadedDeploymentId: string | undefined;
	reportedDeploymentId: string | undefined;
};

const DEFERRED_LOAD_POLL_MS = 100;

/**
 * Before the boot load: what this worker is held for, and which release each component's tree carries as the load
 * begins — the generation its verdict will describe.
 */
export async function beginHeldStart(requests: HeldStartRequest[]): Promise<Map<string, string | undefined>> {
	trackBootOutcomes(requests.map(({ component }) => component));
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const loaded = new Map<string, string | undefined>();
	for (const { component } of requests) {
		loaded.set(component, await liveDeploymentId(componentsRoot, component).catch(() => undefined));
	}
	return loaded;
}

/**
 * After the boot load, before any listener binds: report the verdict and wait to be admitted. A refusal arrives as
 * SHUTDOWN, which the worker's own shutdown path handles; nothing is bound to release.
 */
export async function awaitAdmission(
	requests: HeldStartRequest[],
	loaded: Map<string, string | undefined>
): Promise<void> {
	while (requests.some(({ component }) => bootVerdictOf(component).outcome === 'pending')) {
		await delay(DEFERRED_LOAD_POLL_MS);
	}
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const components: ComponentVerdict[] = [];
	for (const { component } of requests) {
		const { outcome, failures } = bootVerdictOf(component);
		components.push({
			component,
			outcome: outcome as ComponentVerdict['outcome'],
			failures,
			loadedDeploymentId: loaded.get(component),
			reportedDeploymentId: await liveDeploymentId(componentsRoot, component).catch(() => undefined),
		});
	}
	await new Promise<void>((resolve) => {
		const onMessage = (message: any) => {
			if (message?.type !== ITC_EVENT_TYPES.CHILD_ADMITTED) return;
			parentPort.off('message', onMessage);
			resolve();
		};
		parentPort.on('message', onMessage);
		parentPort.postMessage({ type: ITC_EVENT_TYPES.CHILD_COMPONENT_VERDICT, components });
	});
}
