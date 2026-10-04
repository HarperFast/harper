import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketPrecedes } from '../components/componentPreparationLock.ts';
import { ServerError } from '../utility/errors/hdbError.ts';

const PROBE_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const TRANSIENT_FILE_RETRY_DELAYS_MS = [10, 40, 160];
const TRANSIENT_FILE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const lockWait = new Int32Array(new SharedArrayBuffer(4));
let bootId: string;
let ownerIdentity: string;

export class NamedProcessError extends ServerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message);
		this.cause = options?.cause;
	}
}

export interface ProcessIdentity {
	identity: string;
}

function validPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 0;
}

export function parsePidFile(content: string): { pid: number; version: number; identity?: string } {
	const [pidLine, versionLine, identity] = content.split('\n').map((line) => line.trim());
	const pid = /^[1-9]\d*$/.test(pidLine) ? Number(pidLine) : 0;
	return { pid: validPid(pid) ? pid : 0, version: Number.parseInt(versionLine ?? '0', 10), identity };
}

function linuxBootIdentity(): string {
	bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
	if (!bootId) throw new Error('Could not read Linux boot identity');
	return bootId;
}

export function isPreviousBoot(identity: string): boolean {
	return (
		process.platform === 'linux' && identity.startsWith('linux:') && identity.split(':')[1] !== linuxBootIdentity()
	);
}

function linuxProcessIdentity(pid: number): ProcessIdentity | null {
	let startTime: string;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		if (fields[0] === 'Z' || fields[0] === 'X' || fields[0] === 'x') return null;
		const status = readFileSync(`/proc/${pid}/status`, 'utf8');
		const tgid = /^Tgid:\s+(\d+)/m.exec(status)?.[1];
		if (!tgid) throw new Error(`Invalid process status for PID ${pid}`);
		if (Number(tgid) !== pid) return null;
		if (!/^\d+$/.test(fields[19])) throw new Error(`Invalid process start time for PID ${pid}`);
		startTime = fields[19];
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'ESRCH') return confirmProcessAbsent(pid);
		throw error;
	}
	return { identity: `linux:${linuxBootIdentity()}:${pid}:${startTime}` };
}

function processQuery(pid: number) {
	if (process.platform === 'darwin') {
		return {
			command: '/bin/ps',
			args: ['-p', String(pid), '-o', 'lstart=', '-o', 'state='],
			env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
		};
	}
	if (process.platform === 'win32') {
		const script =
			"$ErrorActionPreference = 'Stop'; try { " +
			`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
			"if (!$p) { [Console]::Out.Write('null') } " +
			'elseif (!$p.CreationDate) { exit 2 } else { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString()) } ' +
			'} catch { exit 2 }';
		return {
			command: 'powershell.exe',
			args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
			env: process.env,
		};
	}
	throw new NamedProcessError(`Process identity is unavailable on ${process.platform}`);
}

function confirmProcessAbsent(pid: number): null {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code === 'ESRCH') return null;
		throw error;
	}
	throw new NamedProcessError(`Could not read identity for live PID ${pid}`);
}

function parseProcessQuery(pid: number, output: string): ProcessIdentity | null {
	output = output.trim();
	if (process.platform === 'win32') {
		if (output === 'null') return confirmProcessAbsent(pid);
		if (!/^[1-9]\d*$/.test(output)) throw new Error('Invalid Windows process creation time');
		return { identity: `win32:${pid}:${output}` };
	}
	if (!output) return confirmProcessAbsent(pid);
	const match = /^(.*\d{4})\s+(\S+)\s*$/.exec(output);
	if (!match) throw new Error('Invalid macOS process start time');
	if (match[2].startsWith('Z') || match[2].startsWith('X')) return null;
	return { identity: `darwin:${pid}:${match[1].trim().replace(/\s+/g, ' ')}` };
}

function queryFailure(pid: number, error: any): null {
	if (process.platform === 'darwin' && (error.status === 1 || error.code === 1) && !String(error.stdout ?? '').trim()) {
		return confirmProcessAbsent(pid);
	}
	throw error;
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
	if (!validPid(pid)) throw new NamedProcessError(`Invalid process PID ${pid}`);
	if (process.platform === 'linux') return linuxProcessIdentity(pid);
	const query = processQuery(pid);
	try {
		return parseProcessQuery(
			pid,
			execFileSync(query.command, query.args, {
				env: query.env,
				encoding: 'utf8',
				timeout: PROBE_TIMEOUT_MS,
				windowsHide: true,
			})
		);
	} catch (error) {
		return queryFailure(pid, error);
	}
}

export async function readProcessIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
	if (!validPid(pid)) throw new NamedProcessError(`Invalid process PID ${pid}`);
	if (process.platform === 'linux') return linuxProcessIdentity(pid);
	const query = processQuery(pid);
	return new Promise((resolve, reject) => {
		execFile(
			query.command,
			query.args,
			{
				env: query.env,
				encoding: 'utf8',
				timeout: PROBE_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout) => {
				try {
					if (error) resolve(queryFailure(pid, Object.assign(error, { stdout })));
					else resolve(parseProcessQuery(pid, stdout));
				} catch (error) {
					reject(error);
				}
			}
		);
	});
}

interface SpawnClaim {
	pid: number;
	identity: string;
	token: string;
	ticket?: number;
}

export function withFileRetry<T>(operation: () => T): T {
	for (let attempt = 0; ; attempt++) {
		try {
			return operation();
		} catch (error) {
			if (
				process.platform !== 'win32' ||
				!TRANSIENT_FILE_CODES.has(error.code) ||
				attempt >= TRANSIENT_FILE_RETRY_DELAYS_MS.length
			)
				throw error;
		}
		Atomics.wait(lockWait, 0, 0, TRANSIENT_FILE_RETRY_DELAYS_MS[attempt]);
	}
}

export function writePidRecord(pidFilePath: string, record: string) {
	const stagingPath = `${pidFilePath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(stagingPath, record, { flag: 'wx', mode: 0o600 });
		withFileRetry(() => renameSync(stagingPath, pidFilePath));
	} finally {
		unlinkIfPresent(stagingPath);
	}
}

function unlinkIfPresent(path: string) {
	try {
		withFileRetry(() => unlinkSync(path));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

function releaseClaim(claimPath: string, markerPath: string) {
	try {
		unlinkIfPresent(claimPath);
	} catch {
		writeFileSync(markerPath, '', { flag: 'wx', mode: 0o600 });
	}
}

export function withSpawnPidLock<T>(pidFilePath: string, callback: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
	ownerIdentity ??= readProcessIdentity(process.pid)?.identity;
	if (!ownerIdentity) throw new NamedProcessError('Could not identify the named process lock owner');
	const lockDir = `${pidFilePath}.locks`;
	mkdirSync(lockDir, { recursive: true });
	const owner: SpawnClaim = { pid: process.pid, identity: ownerIdentity, token: randomUUID() };
	const claimPath = join(lockDir, `${owner.token}.json`);
	const stagingPath = join(lockDir, `${owner.token}.tmp`);
	const markerPath = join(lockDir, `${owner.token}.released`);
	const verifiedOwners = new Map<string, number>();
	let deadline = performance.now() + timeoutMs;
	const publish = () => {
		writeFileSync(stagingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
		withFileRetry(() => renameSync(stagingPath, claimPath));
	};
	const scan = (): SpawnClaim[] => {
		const claims: SpawnClaim[] = [];
		const names = readdirSync(lockDir);
		const released = new Set(names.filter((name) => name.endsWith('.released')));
		for (const name of names) {
			if (!name.endsWith('.json') || name === `${owner.token}.json`) continue;
			const path = join(lockDir, name);
			const markerName = `${name.slice(0, -5)}.released`;
			if (released.has(markerName)) {
				try {
					unlinkIfPresent(path);
					unlinkIfPresent(join(lockDir, markerName));
				} catch {}
				continue;
			}
			let claim: SpawnClaim;
			try {
				claim = JSON.parse(withFileRetry(() => readFileSync(path, 'utf8')));
			} catch (error) {
				if (error.code === 'ENOENT' || existsSync(join(lockDir, markerName))) continue;
				throw error;
			}
			if (
				!validPid(claim.pid) ||
				typeof claim.identity !== 'string' ||
				typeof claim.token !== 'string' ||
				(claim.ticket !== undefined && (!Number.isSafeInteger(claim.ticket) || claim.ticket < 1))
			) {
				throw new NamedProcessError(`Invalid named process lock claim ${path}`);
			}
			let identity = ownerIdentity;
			if (claim.pid !== process.pid) {
				const verifiedAt = verifiedOwners.get(claim.identity);
				if (verifiedAt !== undefined && performance.now() - verifiedAt < 1000) identity = claim.identity;
				else {
					identity = isPreviousBoot(claim.identity) ? undefined : readProcessIdentity(claim.pid)?.identity;
					if (identity === claim.identity) verifiedOwners.set(claim.identity, performance.now());
				}
			}
			if (identity !== claim.identity) unlinkIfPresent(path);
			else claims.push(claim);
		}
		return claims;
	};
	try {
		publish();
		owner.ticket = scan().reduce((maximum, claim) => Math.max(maximum, claim.ticket ?? 0), 0) + 1;
		publish();
		let previousQueue: string;
		while (true) {
			const preceding = scan().filter((claim) => claim.ticket === undefined || ticketPrecedes(claim, owner));
			if (!preceding.length) break;
			const queue = preceding
				.map((claim) => `${claim.token}:${claim.ticket ?? 'choosing'}`)
				.sort()
				.join(',');
			if (queue !== previousQueue) {
				deadline = performance.now() + timeoutMs;
				previousQueue = queue;
			}
			if (performance.now() >= deadline)
				throw new NamedProcessError(`Timed out acquiring named process lock ${pidFilePath}`);
			Atomics.wait(lockWait, 0, 0, 50);
		}
		return callback();
	} finally {
		try {
			unlinkIfPresent(stagingPath);
		} finally {
			releaseClaim(claimPath, markerPath);
		}
	}
}
