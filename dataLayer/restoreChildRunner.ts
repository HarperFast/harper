import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClientError } from '../utility/errors/hdbError.ts';
import { getHdbBasePath, getConfigOverrides } from '../utility/environment/environmentManager.ts';
import { restoreChildLockPath } from './restoreMarker.ts';
import logger from '../utility/logging/harper_logger.ts';

const RESTORE_CHILD_SLOT_FILE = '.restore-child.lock';
const OUTPUT_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const AUTHORIZE_TIMEOUT_MS = 30_000;
const DEFAULT_HEAP_MB = 1024;
// Native budgets for the child's own RocksDB handles. The server's default (25% of memory) is per
// process, so inheriting it would let one child double the instance's block cache.
const CHILD_BLOCK_CACHE_BYTES = 64 * 1024 * 1024;
const CHILD_WRITE_BUFFER_BYTES = 32 * 1024 * 1024;

export type RestoreChildCommand = 'verify' | 'apply-and-prove' | 'pre-restore-backup' | 'import-archive';

export interface ReceiptAuthorization {
	databasePath: string;
	operationId: string;
	attempt: number;
	/** The state the receipt must be in; `applying` unless the command runs before destruction. */
	state?: 'pending' | 'applying';
}

export interface RestoreChildSpec {
	slotLockPath: string;
	targetLockPath?: string;
	authorizeTimeoutMs: number;
	configOverrides?: Record<string, unknown>;
	blockCacheSize: number;
	writeBufferManagerSize: number;
}

export type ParentToChild = {
	type: 'authorize';
	command: RestoreChildCommand;
	args: Record<string, unknown>;
	receipt?: ReceiptAuthorization;
};

export type ChildToParent =
	| { type: 'ready'; pid: number }
	| { type: 'refused'; reason: 'busy' | 'target-busy' }
	| { type: 'result'; result: any }
	| { type: 'error'; name?: string; message: string; statusCode?: number; phase?: string; cause?: string };

export interface RestoreChildOptions {
	/** The database directory the child will work on; its child-lifetime lock is taken by the child. */
	databasePath?: string;
	/** When set, the child re-reads the receipt and proceeds only if it still names this attempt. */
	receipt?: ReceiptAuthorization;
	timeoutMs?: number;
	heapMb?: number;
}

export class RestoreChildError extends Error {
	statusCode?: number;
	constructor(message: string, statusCode?: number, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'RestoreChildError';
		if (statusCode) this.statusCode = statusCode;
	}
}

export { restoreChildLockPath };

/** The instance-wide slot every restore, import and verification child takes first. */
export function restoreChildSlotLockPath(): string {
	return join(getHdbBasePath(), RESTORE_CHILD_SLOT_FILE);
}

function childScriptPath(): string {
	const compiled = join(__dirname, 'restoreChild.js');
	return existsSync(compiled) ? compiled : join(__dirname, 'restoreChild.ts');
}

function capped(stream: NodeJS.ReadableStream | null): () => string {
	let text = '';
	stream?.on('data', (chunk) => {
		if (text.length < OUTPUT_CAP_BYTES) text += String(chunk).slice(0, OUTPUT_CAP_BYTES - text.length);
	});
	return () => text;
}

function killGroup(child: ChildProcess): void {
	try {
		if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
		else child.kill('SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
}

function registerChildGroup(child: ChildProcess): (() => void) | undefined {
	if (process.platform === 'win32' || !child.pid) return undefined;
	try {
		const manageThreads = require('../server/threads/manageThreads.js');
		const generation = manageThreads.registerProcessGroup?.(child.pid);
		if (generation === undefined) return undefined;
		return () => manageThreads.unregisterProcessGroup?.(child.pid, generation);
	} catch {
		// outside a Harper server (the offline CLI) there is no thread to tie the group to
		return undefined;
	}
}

/**
 * Runs one command in a bounded child process and returns its result. Child death of any kind —
 * signal, non-zero exit, timeout, refusal — rejects; nothing the child left behind is cleaned up
 * here, because the receipt, marker and pins that protect the target are the parent's, unchanged.
 */
export function runRestoreChild<T = any>(
	command: RestoreChildCommand,
	args: Record<string, unknown>,
	options: RestoreChildOptions = {}
): Promise<T> {
	const spec: RestoreChildSpec = {
		slotLockPath: restoreChildSlotLockPath(),
		targetLockPath: options.databasePath ? restoreChildLockPath(options.databasePath) : undefined,
		authorizeTimeoutMs: AUTHORIZE_TIMEOUT_MS,
		configOverrides: getConfigOverrides(),
		blockCacheSize: CHILD_BLOCK_CACHE_BYTES,
		writeBufferManagerSize: CHILD_WRITE_BUFFER_BYTES,
	};
	const execArgv = [
		...process.execArgv.filter((arg) => !arg.startsWith('--max-old-space-size') && !arg.startsWith('--inspect')),
		`--max-old-space-size=${options.heapMb ?? DEFAULT_HEAP_MB}`,
	];
	return new Promise<T>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = fork(childScriptPath(), [], {
				env: { ...process.env, HARPER_RESTORE_CHILD_SPEC: JSON.stringify(spec) },
				execArgv,
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				detached: process.platform !== 'win32',
			});
		} catch (error) {
			return reject(new RestoreChildError(`Could not start the restore child for ${command}`, undefined, error));
		}
		const unregister = registerChildGroup(child);
		const stdout = capped(child.stdout);
		const stderr = capped(child.stderr);
		let settled = false;
		let outcome: ChildToParent | undefined;
		const settle = (error: Error | undefined, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unregister?.();
			if (error) reject(error);
			else resolve(value as T);
		};
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timedOut = false;
		// settled from the exit handler, so a retry never races the child it is replacing
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutMs);
		child.on('message', (message: ChildToParent) => {
			if (message?.type === 'ready') {
				const authorize: ParentToChild = { type: 'authorize', command, args, receipt: options.receipt };
				child.send(authorize);
			} else if (message?.type === 'refused') {
				outcome = message;
				settle(
					new ClientError(
						message.reason === 'busy'
							? 'Another restore, import or backup verification is running on this instance; retry once it finishes'
							: 'A restore process for this database is still running; retry once it exits',
						409
					)
				);
			} else if (message?.type === 'result' || message?.type === 'error') {
				outcome = message;
			}
		});
		child.on('error', (error) => {
			killGroup(child);
			settle(new RestoreChildError(`The restore child running ${command} failed`, undefined, error));
		});
		child.on('exit', (code, signal) => {
			if (timedOut) {
				return settle(
					new RestoreChildError(`The restore child running ${command} did not finish within ${timeoutMs}ms`)
				);
			}
			if (outcome?.type === 'result' && code === 0) return settle(undefined, outcome.result);
			if (outcome?.type === 'error') {
				const error: any =
					outcome.statusCode && outcome.statusCode < 500
						? new ClientError(outcome.message, outcome.statusCode)
						: new RestoreChildError(outcome.message, outcome.statusCode);
				if (outcome.phase) error.phase = outcome.phase;
				return settle(error);
			}
			const tail = stderr().trim().split('\n').slice(-5).join('\n');
			logger.debug?.(`restore child output for ${command}`, { stdout: stdout(), stderr: stderr() });
			settle(
				new RestoreChildError(
					`The restore child running ${command} exited ${signal ? `on ${signal}` : `with code ${code}`} without a result${tail ? `: ${tail}` : ''}`
				)
			);
		});
	});
}
