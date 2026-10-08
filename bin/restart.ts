'use strict';

import minimist from 'minimist';
import { isMainThread, parentPort } from 'worker_threads';
import * as hdbTerms from '../utility/hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import * as processMan from '../utility/processManagement/processManagement.js';
import { compactOnStart } from './copyDb.ts';
import {
	beginProcessShutdown,
	restartWorkers,
	isThreadRunning,
	decodeRestartScope,
	getRunningIsolatedApplications,
	onMessageByType,
	shutdownWorkersNow,
} from '../server/threads/manageThreads.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES } = hdbErrors;
import * as envMgr from '../utility/environment/environmentManager.ts';
import * as path from 'node:path';
import { getConfigObj, getConfigPath } from '../config/configUtils.ts';
import { withComponentPreparationLock } from '../components/componentPreparationLock.ts';
import { awaitRestart } from '../components/awaitRestart.ts';
import { rmSync } from 'node:fs';
import { getThisNodeName } from '../server/nodeName.ts';
import { armRestartExitWatchdog } from './restartExitWatchdog.ts';
envMgr.initSync();

const RESTART_RESPONSE = `Restarting Harper. This may take up to ${hdbTerms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const INVALID_SERVICE_ERR = 'Invalid service';
const ISOLATED_TOPOLOGY_REQUEST_TIMEOUT_MS = 5000;

let calledFromCli;

export { restart, restartService, activateDeploymentOnPeers };

// Add ITC event listener to main thread which will be called from child that receives restart request.
if (isMainThread) {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.RESTART, async (message, port) => {
		try {
			// `scope` stays in its wire form ('' pool, a name, absent = all) until restartService decodes it once
			if (message.removeBranchesFor)
				await restartThenRemoveBranches(message.workerType, message.removeBranchesFor, message.scope);
			else if (message.workerType)
				await restartService({
					service: message.workerType,
					scope: message.scope,
					scopeFallback: message.scopeFallback,
				});
			else restart({ operation: 'restart' });
		} finally {
			port.postMessage({ type: 'restart-complete' });
		}
	});
}

/**
 * Restart, then remove the branches of an application dropped on a worker (which cannot outlive the
 * restart it asked for). The restart happens even if the component lock cannot be taken.
 */
async function restartThenRemoveBranches(service: string, project: string, scope: string | undefined): Promise<void> {
	let restarted = false;
	const restartHttpWorkers = () => {
		restarted = true;
		processMan.expectedRestartOfChildren();
		hdbLogger.notify('Restarting http_workers');
		// Bounded: it queues behind other restarts, and one of them may be reloading a component that waits on this lock.
		return awaitRestart((onProgress) =>
			restartWorkers('http', undefined, true, onProgress, decodeRestartScope({ scope }))
		);
	};
	try {
		const componentPath = path.join(getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT) as string, project);
		await withComponentPreparationLock(
			componentPath,
			async () => {
				const outcome = await restartHttpWorkers();
				if (!outcome.completed || outcome.workersKeptOnOldCode) {
					hdbLogger.warn(
						`Branched database storage of ${project} was left in place: the restart did not finish replacing every worker`
					);
					return;
				}
				// The worker's drop lock was released before this one was taken; a same-name deploy that landed
				// in between owns these branches now.
				if (getConfigObj()?.[project]) {
					hdbLogger.warn(`${project} was deployed again since it was dropped; leaving its branched databases in place`);
					return;
				}
				const { removeBranchesForApplication } = await import('../resources/branchDatabase.ts');
				await removeBranchesForApplication(project);
			},
			{
				timeoutMs: 5 * 60 * 1000,
				onWait: (owner) =>
					hdbLogger.debug?.(
						`Waiting to restart after dropping ${project}` +
							(owner ? ` behind process ${owner.pid}, thread ${owner.threadId}` : '')
					),
				isOwnerAlive: (owner) => owner.pid !== process.pid || isThreadRunning(owner.threadId),
			}
		);
	} catch (error) {
		hdbLogger.error(`Could not remove the branched database storage of ${project}`, error);
		if (!restarted) await restartService({ service, scope });
	}
}

/**
 * Restart Harper.
 * It will restart all the child threads and the hub and leaf server processes.
 * @param req
 * @returns {Promise<string>}
 */
async function restart(req: any) {
	calledFromCli = Object.keys(req).length === 0;

	const cliArgs = minimist(process.argv);
	if (cliArgs.service) {
		await restartService(cliArgs);
		return;
	}

	if (calledFromCli) {
		const hdbPid = processMan.getHdbPid();
		console.error(hdbPid ? 'Restarting Harper...' : 'Starting Harper...');
		require('./run').launch(true);
		return RESTART_RESPONSE;
	}

	if (isMainThread) {
		hdbLogger.notify(RESTART_RESPONSE);

		if (envMgr.get(hdbTerms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) {
			hdbLogger.info('Compacting storage before restart; the restart timeout begins after compaction completes');
			await compactOnStart();
		}

		setTimeout(async () => {
			try {
				// Latch before the watchdog handshake, not at shutdownWorkersNow() below: a component's
				// debounced requestRestart() landing in between would otherwise reload root components and
				// pre-start an HTTP replacement into a process that is already exiting.
				beginProcessShutdown();
				// Off Linux the watchdog can never arm, and armRestartExitWatchdog() has already warned.
				if (
					process.env.HARPER_EXIT_ON_RESTART &&
					!(await armRestartExitWatchdog(hdbTerms.RESTART_TIMEOUT_MS)) &&
					process.platform === 'linux'
				)
					hdbLogger.error('Restart exit watchdog is unavailable; restart teardown is unbounded');
				// It seems like you should just be able to start the other process and kill this process and everything should
				// be cleaned up, however that doesn't work for some reason; the socket listening fds somehow get transferred to the
				// child process if they are not explicitly closed. And when transferred they are orphaned listening, accepting
				// connections and hanging. So we need to explicitly close down all the workers and then start the new process
				// and shut down.
				hdbLogger.debug('Shutdown workers');
				await shutdownWorkersNow();
				const { closeServers } = require('../server/threads/threadServer.js');
				await closeServers();
				await processMan.cleanupChildrenProcesses(false);
				// remove pid file so it doesn't trip up the launch
				rmSync(path.join(envMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), hdbTerms.HDB_PID_FILE), { force: true });
				hdbLogger.debug('Starting new process...');
				if (process.env.HARPER_EXIT_ON_RESTART) {
					// use this to exit the process so that it will be restarted by the
					// PM/container/orchestrator.
					hdbLogger.warn('Exiting Harper process to trigger a container restart');
					process.exit(0);
				}
				// now launch the new process and exit this process
				await require('./run').launch(true);
			} catch (error) {
				hdbLogger.fatal('Restart teardown failed; exiting Harper', error);
				process.exit(1);
			}
		}, 50); // can't await this because it is going to do an exit(), but wait for 50ms so we give the HTTP thread a
		// chance to return a response
	} else {
		// Post msg to main parent thread requesting it restart (so the main thread can process.exit())
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.RESTART,
		});
	}

	return RESTART_RESPONSE;
}

const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A certified rolling deploy's second half: the release is staged on every peer, and this activates it on one peer
 * at a time, each certifying it with its own restart. Every peer is visited — each decides for itself — and the job
 * fails at the end naming each one that did not take it.
 */
async function activateDeploymentOnPeers(activation: any) {
	const { project, deployment_id: deploymentId, deployment_row: deploymentRow, nodes } = activation ?? {};
	if (
		typeof project !== 'string' ||
		!DEPLOYMENT_ID_PATTERN.test(deploymentId) ||
		!DEPLOYMENT_ID_PATTERN.test(deploymentRow) ||
		(nodes !== undefined && (!Array.isArray(nodes) || nodes.some((node) => typeof node !== 'string')))
	) {
		throw handleHDBError(
			new Error(),
			'Invalid activate_deployment: expected project, deployment_id, deployment_row and an optional list of nodes',
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	const thisNode = getThisNodeName();
	const otherNodes = ((global as any).server.nodes ?? []).filter((node) => node.name !== thisNode);
	const peers = otherNodes.filter((node) => !nodes || nodes.includes(node.name));
	const results = [];
	if (peers.length > 0) await activateEachPeer(peers, { project, deploymentId, deploymentRow }, results);
	// A peer that staged the release and left the topology before its turn was not activated, which is a failure too.
	for (const name of nodes ?? []) {
		if (name !== thisNode && !otherNodes.some((node) => node.name === name)) {
			results.push({ node: name, error: 'it is no longer one of the nodes in this cluster' });
		}
	}
	const failed = results.filter((result) => result.error);
	if (failed.length > 0) {
		const error: any = new Error(
			`Deployment ${deploymentId} of ${project} was not activated on ${failed.length} of ${results.length} peer ` +
				`node(s): ${failed.map((result) => `${result.node} (${result.error})`).join('; ')}`
		);
		// What a failed job records as its message, so get_job keeps every peer's outcome.
		error.http_resp_msg = { error: error.message, activated: results };
		throw error;
	}
	return { activated: results };
}

async function activateEachPeer(peers: any[], { project, deploymentId, deploymentRow }, results: any[]) {
	const replication = (global as any).server.replication;
	replication.monitorNodeCAs();
	const { peerDeployAnswerTimeoutMs } = await import('../components/operations.js');
	const timeoutMs = peerDeployAnswerTimeoutMs({ restart: true });
	for (const node of peers) {
		try {
			const response = await replication.sendOperationToNode(
				node,
				{
					operation: 'deploy_component',
					project,
					deployment_id: deploymentId,
					_deploymentId: deploymentRow,
					restart: true,
					replicated: false,
				},
				{ timeoutMs }
			);
			const answer = response?.value ?? response?.body ?? response;
			results.push({ node: node.name, certification: answer?.certification, message: answer?.message });
		} catch (error) {
			results.push({ node: node.name, error: error?.message ?? String(error) });
		}
	}
}

/**
 * Used to restart a particular service, services includes - httpWorkers
 * @param req
 * @returns {Promise<string>}
 */
async function restartService(req: any) {
	let { service } = req;
	if (hdbTerms.HDB_PROCESS_SERVICES[service] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	const requestedScope = decodeRestartScope(req);
	if (requestedScope !== undefined && typeof requestedScope !== 'string') {
		throw handleHDBError(
			new Error(),
			'Invalid HTTP worker restart scope: expected a string',
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	let fallbackScope;
	if (req.scopeFallback !== undefined) {
		fallbackScope = decodeRestartScope({ scope: req.scopeFallback });
		if (fallbackScope !== undefined) {
			throw handleHDBError(
				new Error(),
				'Invalid HTTP worker restart scope fallback: expected the pool scope',
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
	}
	if (typeof requestedScope === 'string' && requestedScope !== '*' && req.scopeFallback === undefined) {
		envMgr.initSync(true);
		const { isIsolatedApplication } = await import('../server/threads/isolatedApplications.ts');
		const configured = isIsolatedApplication(requestedScope);
		const runningApplications = configured
			? []
			: await getRunningIsolatedApplications(ISOLATED_TOPOLOGY_REQUEST_TIMEOUT_MS);
		if (!configured && !runningApplications.includes(requestedScope)) {
			throw handleHDBError(
				new Error(),
				`Unknown isolated application restart scope: ${requestedScope}`,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
	}
	if (req.activate_deployment !== undefined) {
		if (isMainThread) {
			throw handleHDBError(
				new Error(),
				'activate_deployment runs as a job',
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
		return activateDeploymentOnPeers(req.activate_deployment);
	}
	processMan.expectedRestartOfChildren();
	if (!isMainThread) {
		if (req.replicated) {
			(global as any).server.replication.monitorNodeCAs(); // get all the CAs from the nodes we know about
		}
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.RESTART,
			workerType: service,
			scope: req.scope, // wire form, forwarded as received
			scopeFallback: req.scopeFallback,
		});
		parentPort.ref(); // don't let the parent thread exit until we're done
		await new Promise<void>((resolve) => {
			parentPort.on('message', (msg) => {
				if (msg.type === 'restart-complete') {
					resolve();
					parentPort.unref();
				}
			});
		});
		let replicatedResponses;
		if (req.replicated) {
			req.replicated = false; // don't send a replicated flag to the nodes we are sending to
			replicatedResponses = [];
			for (let node of (global as any).server.nodes) {
				if (node.name === getThisNodeName()) continue;
				// for now, only one at a time
				let job_id;
				try {
					({ job_id } = await (global as any).server.replication.sendOperationToNode(node, req));
				} catch (err) {
					// If request to node fails, add the error to the response and continue to the next node
					replicatedResponses.push({ node: node.name, message: err.message });
					continue;
				}
				// wait for the job to finish by polling for the completion of the job
				replicatedResponses.push(
					await new Promise((resolve, reject) => {
						const RETRY_INTERVAL = 250;
						let retriesLeft = 2400; // 10 minutes
						let interval = setInterval(async () => {
							if (retriesLeft-- <= 0) {
								clearInterval(interval);
								let error: any = new Error('Timed out waiting for restart job to complete');
								error.replicated = replicatedResponses; // report the finished restarts
								reject(error);
							}
							let response = await (global as any).server.replication.sendOperationToNode(node, {
								operation: 'get_job',
								id: job_id,
							});
							const jobResult = response.results[0];
							if (jobResult.status === 'COMPLETE') {
								clearInterval(interval);
								resolve({ node: node.name, message: jobResult.message });
							}
							if (jobResult.status === 'ERROR') {
								clearInterval(interval);
								let error: any = new Error(jobResult.message);
								error.replicated = replicatedResponses; // report the finished restarts
								reject(error);
							}
						}, RETRY_INTERVAL);
					})
				);
			}
			return { replicated: replicatedResponses };
		}
		return;
	}

	let errMsg;
	switch (service) {
		case 'custom_functions':
		case 'custom functions':
		case hdbTerms.HDB_PROCESS_SERVICES.harperdb:
		case hdbTerms.HDB_PROCESS_SERVICES.http_workers:
		case hdbTerms.HDB_PROCESS_SERVICES.http:
			if (calledFromCli) console.log(`Restarting httpWorkers`);
			hdbLogger.notify('Restarting http_workers');

			if (calledFromCli) {
				await processMan.restart(hdbTerms.PROCESS_DESCRIPTORS.HDB);
			} else {
				let scope = requestedScope;
				if (req.scopeFallback !== undefined && typeof scope === 'string' && scope !== '*') {
					const runningApplications = await getRunningIsolatedApplications(ISOLATED_TOPOLOGY_REQUEST_TIMEOUT_MS);
					if (!runningApplications.includes(scope)) scope = fallbackScope;
				}
				// An operator's restart names no scope; every deploy and drop names one, so only an operator
				// restart reaches the dedicated pools (which load no application code).
				const workerTypes =
					req.scope === undefined ? [hdbTerms.THREAD_TYPES.HTTP, hdbTerms.THREAD_TYPES.REPLICATION] : 'http';
				await restartWorkers(workerTypes, undefined, true, null, scope);
			}
			break;
		default:
			errMsg = `Unrecognized service: ${service}`;
			break;
	}

	if (errMsg) {
		hdbLogger.error(errMsg);
		if (calledFromCli) console.error(errMsg);
		return errMsg;
	}
	if (service === 'custom_functions') service = 'Custom Functions';
	return `Restarting ${service}`;
}
