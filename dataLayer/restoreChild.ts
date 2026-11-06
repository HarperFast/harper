/**
 * Entry point of the restore child process (see restoreChildRunner.ts). Everything here runs in a
 * separate, bounded process so that decoding or opening an untrusted or damaged database — a native
 * abort, heap exhaustion — costs this process, never Harper.
 *
 * Start-up order is the contract: take the instance slot and the target's child-lifetime lock, report
 * `ready`, and do nothing else until the parent — which still holds the target's reservation — sends
 * an `authorize`. A child whose parent died, or whose receipt on disk is no longer the one it was
 * started for, exits without touching the engine.
 */
import { writeFileSync } from 'node:fs';
import { tryFileLock } from '@harperfast/rocksdb-js';
import type { RestoreChildSpec, ChildToParent, ParentToChild } from './restoreChildRunner.ts';

const EXIT_DISCONNECTED = 70;
const EXIT_REFUSED = 75;
const EXIT_NOT_AUTHORIZED = 77;

function send(message: ChildToParent): Promise<void> {
	return new Promise((resolve) => {
		if (!process.connected) return resolve();
		process.send!(message, undefined, {}, () => resolve());
	});
}

async function finish(message: ChildToParent, code: number): Promise<never> {
	await send(message);
	process.exit(code);
}

function waitForAuthorization(timeoutMs: number): Promise<Extract<ParentToChild, { type: 'authorize' }>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no authorization arrived')), timeoutMs);
		process.on('message', (message: ParentToChild) => {
			if (message?.type !== 'authorize') return;
			clearTimeout(timer);
			resolve(message);
		});
	});
}

async function main(): Promise<void> {
	process.on('disconnect', () => process.exit(EXIT_DISCONNECTED));
	const spec: RestoreChildSpec = JSON.parse(process.env.HARPER_RESTORE_CHILD_SPEC ?? '{}');
	if (!tryFileLock(spec.slotLockPath)) {
		await finish({ type: 'refused', reason: 'busy' }, EXIT_REFUSED);
	}
	if (spec.targetLockPath && !tryFileLock(spec.targetLockPath)) {
		await finish({ type: 'refused', reason: 'target-busy' }, EXIT_REFUSED);
	}
	if (process.platform === 'linux') {
		try {
			// under a container memory limit, the OOM killer should pick this process over Harper
			writeFileSync('/proc/self/oom_score_adj', '1000');
		} catch {
			// best effort: not permitted in every container
		}
	}
	await send({ type: 'ready', pid: process.pid });
	let authorization: Extract<ParentToChild, { type: 'authorize' }>;
	try {
		authorization = await waitForAuthorization(spec.authorizeTimeoutMs);
	} catch {
		process.exit(EXIT_NOT_AUTHORIZED);
	}
	try {
		const { initializeRestoreChildEnvironment, runRestoreChildCommand, assertReceiptAuthorizes } =
			await import('./restoreChildCommands.ts');
		initializeRestoreChildEnvironment(spec);
		if (authorization.receipt && !assertReceiptAuthorizes(authorization.receipt)) {
			process.exit(EXIT_NOT_AUTHORIZED);
		}
		const result = await runRestoreChildCommand(authorization.command, authorization.args);
		await finish({ type: 'result', result }, 0);
	} catch (error: any) {
		await finish(
			{
				type: 'error',
				name: error?.name,
				message: error?.message ?? String(error),
				statusCode: error?.statusCode,
				phase: error?.phase,
				cause: error?.cause?.message,
			},
			1
		);
	}
}

if (process.env.HARPER_RESTORE_CHILD_SPEC && process.send) {
	main().catch(() => process.exit(1));
}
