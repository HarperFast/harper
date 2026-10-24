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
	decodeRestartScope,
	getRunningIsolatedApplications,
	onMessageByType,
	shutdownWorkersNow,
} from '../server/threads/manageThreads.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES } = hdbErrors;
import * as envMgr from '../utility/environment/environmentManager.ts';
import * as path from 'node:path';
import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { getThisNodeName } from '../server/nodeName.ts';
import { armRestartExitWatchdog } from './restartExitWatchdog.ts';
import { PRODUCT_NAME } from '../utility/packageUtils.js';
envMgr.initSync();

const RESTART_RESPONSE = `Restarting ${PRODUCT_NAME}. This may take up to ${hdbTerms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const INVALID_SERVICE_ERR = 'Invalid service';
const ISOLATED_TOPOLOGY_REQUEST_TIMEOUT_MS = 5000;

let calledFromCli;

export { restart, restartService, activateDeploymentOnPeers, restartEachPeer };

// Add ITC event listener to main thread which will be called from child that receives restart request.
if (isMainThread) {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.RESTART, async (message, port) => {
		try {
			// `scope` stays in its wire form ('' pool, a name, absent = all) until restartService decodes it once
			if (message.workerType)
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
		console.error(hdbPid ? `Restarting ${PRODUCT_NAME}...` : `Starting ${PRODUCT_NAME}...`);
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
					hdbLogger.warn(`Exiting ${PRODUCT_NAME} process to trigger a container restart`);
					process.exit(0);
				}
				// now launch the new process and exit this process
				await require('./run').launch(true);
			} catch (error) {
				hdbLogger.fatal(`Restart teardown failed; exiting ${PRODUCT_NAME}`, error);
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

const PEER_RESTART_TIMING = {
	attempts: 3,
	retryDelayMs: 1000,
	dispatchTimeoutMs: 60 * 1000,
	pollIntervalMs: 250,
	pollTimeoutMs: 30 * 1000,
	jobDeadlineMs: 10 * 60 * 1000,
};
// A peer that refused the operation for write back-pressure never started it. Errors cross replication as
// text, and 5.3 peers word it "too long of queue".
const WRITE_QUEUE_BACK_PRESSURE = /Outstanding write transactions have too long (?:a|of) queue/;
// Rejections known to precede the request reaching the peer. Anything else with a socket error code, or the
// replicator's "outcome there is unknown" (a timeout, or the connection closing first) or the session's code-less
// "Connection closed" rejection of requests pending at close, may have started it.
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const OUTCOME_UNKNOWN = /outcome there is unknown|^Connection closed\b/;
const PEER_JOB_PENDING: string[] = [hdbTerms.JOB_STATUS_ENUM.CREATED, hdbTerms.JOB_STATUS_ENUM.IN_PROGRESS];

// See components/DESIGN.md, "A rolling restart job completes only if every peer restarted".
async function restartEachPeer(peers: any[], request: any, timing = PEER_RESTART_TIMING) {
	const replication = (global as any).server.replication;
	const replicated = [];
	const queue = peers.map((node) => ({ node, attempt: 1, retryAt: 0 }));
	let haltedBy: string | undefined;
	while (queue.length > 0) {
		const { node, attempt, retryAt } = queue.shift();
		if (haltedBy) {
			replicated.push({ node: node.name, error: `skipped: the restart of ${haltedBy} did not complete` });
			continue;
		}
		if (retryAt > Date.now()) await delay(retryAt - Date.now());
		let jobId;
		try {
			const answer = await replication.sendOperationToNode(node, request, { timeoutMs: timing.dispatchTimeoutMs });
			jobId = answer?.job_id;
		} catch (error) {
			const message = error?.message ?? String(error);
			if (attempt < timing.attempts && WRITE_QUEUE_BACK_PRESSURE.test(message)) {
				hdbLogger.warn(`Restart of ${node.name} was refused (${message}); retrying after the other nodes`);
				queue.push({ node, attempt: attempt + 1, retryAt: Date.now() + timing.retryDelayMs * 2 ** (attempt - 1) });
			} else {
				replicated.push({ node: node.name, error: message });
				if (mayHaveStarted(error, message)) haltedBy = node.name;
			}
			continue;
		}
		const outcome = jobId
			? await awaitPeerJob(replication, node, jobId, timing)
			: { node: node.name, error: 'it answered without a restart job id' };
		replicated.push(outcome);
		if (outcome.error !== undefined) haltedBy = node.name;
	}
	const failed = replicated.filter((outcome) => outcome.error !== undefined);
	if (failed.length > 0) {
		const error: any = new Error(
			`Restart of ${request.service} did not complete on ${failed.length} of ${replicated.length} peer node(s): ` +
				failed
					.map(({ node, error }) => `${node} (${typeof error === 'string' ? error : JSON.stringify(error)})`)
					.join('; ')
		);
		error.result = { replicated };
		throw error;
	}
	return { replicated };
}

// A peer's own error answer carries no code; a socket error usually does, a session close does not.
function mayHaveStarted(error: any, message: string) {
	if (OUTCOME_UNKNOWN.test(message)) return true;
	const code = error?.code;
	return code !== undefined && !NEVER_CONNECTED.has(code);
}

async function awaitPeerJob(replication: any, node: any, jobId: string, timing: typeof PEER_RESTART_TIMING) {
	const deadline = Date.now() + timing.jobDeadlineMs;
	let lastPollError;
	while (Date.now() < deadline) {
		await delay(timing.pollIntervalMs);
		let response;
		try {
			response = await replication.sendOperationToNode(
				node,
				{ operation: 'get_job', id: jobId },
				{ timeoutMs: Math.max(1, Math.min(timing.pollTimeoutMs, deadline - Date.now())) }
			);
		} catch (error) {
			// The peer drops this connection while it restarts its own workers.
			lastPollError = error?.message ?? String(error);
			hdbLogger.debug?.(`Polling restart job ${jobId} on ${node.name} failed, still waiting:`, lastPollError);
			continue;
		}
		lastPollError = undefined;
		const job = response?.results?.[0];
		if (!job) return { node: node.name, error: `its restart job ${jobId} was not found` };
		if (job.status === hdbTerms.JOB_STATUS_ENUM.COMPLETE) return { node: node.name, message: job.message };
		if (job.status === hdbTerms.JOB_STATUS_ENUM.ERROR)
			return { node: node.name, error: job.message ?? `its restart job ${jobId} failed` };
		if (!PEER_JOB_PENDING.includes(job.status))
			return { node: node.name, error: `its restart job ${jobId} reported status ${job.status}` };
	}
	return {
		node: node.name,
		error:
			`Timed out waiting for restart job ${jobId} to complete` +
			(lastPollError ? `; the last poll failed: ${lastPollError}` : ''),
	};
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
		if (req.replicated) {
			const thisNode = getThisNodeName();
			const peers = ((global as any).server.nodes ?? []).filter((node) => node.name !== thisNode);
			return restartEachPeer(peers, { ...req, replicated: false });
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
