import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketPrecedes } from '../components/componentPreparationLock.ts';

const PROBE_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 30_000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
let bootId: string;
let ownerIdentity: string;

export class NamedProcessError extends Error {
	statusCode = 500;
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
		if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
		throw error;
	}
	bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
	if (!bootId) throw new Error('Could not read Linux boot identity');
	return { identity: `linux:${bootId}:${pid}:${startTime}` };
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

function parseProcessQuery(pid: number, output: string): ProcessIdentity | null {
	output = output.trim();
	if (process.platform === 'win32') {
		if (output === 'null') return null;
		if (!/^[1-9]\d*$/.test(output)) throw new Error('Invalid Windows process creation time');
		return { identity: `win32:${pid}:${output}` };
	}
	if (!output) return null;
	const match = /^(.*\d{4})\s+(\S+)\s*$/.exec(output);
	if (!match) throw new Error('Invalid macOS process start time');
	if (match[2].startsWith('Z') || match[2].startsWith('X')) return null;
	return { identity: `darwin:${pid}:${match[1].trim().replace(/\s+/g, ' ')}` };
}

function queryFailure(error: any): null {
	if (process.platform === 'darwin' && (error.status === 1 || error.code === 1) && !String(error.stdout ?? '').trim()) {
		return null;
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
		return queryFailure(error);
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
					if (error) resolve(queryFailure(Object.assign(error, { stdout })));
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

function unlinkIfPresent(path: string) {
	try {
		unlinkSync(path);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
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
	const deadline = performance.now() + timeoutMs;
	const publish = () => {
		writeFileSync(stagingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
		renameSync(stagingPath, claimPath);
	};
	const scan = (): SpawnClaim[] => {
		const claims: SpawnClaim[] = [];
		for (const name of readdirSync(lockDir)) {
			if (!name.endsWith('.json') || name === `${owner.token}.json`) continue;
			const path = join(lockDir, name);
			let claim: SpawnClaim;
			try {
				claim = JSON.parse(readFileSync(path, 'utf8'));
			} catch (error) {
				if (error.code === 'ENOENT') continue;
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
			const identity = claim.pid === process.pid ? ownerIdentity : readProcessIdentity(claim.pid)?.identity;
			if (identity !== claim.identity) unlinkIfPresent(path);
			else claims.push(claim);
		}
		return claims;
	};
	try {
		publish();
		owner.ticket = scan().reduce((maximum, claim) => Math.max(maximum, claim.ticket ?? 0), 0) + 1;
		publish();
		while (scan().some((claim) => claim.ticket === undefined || ticketPrecedes(claim, owner))) {
			if (performance.now() >= deadline)
				throw new NamedProcessError(`Timed out acquiring named process lock ${pidFilePath}`);
			Atomics.wait(lockWait, 0, 0, 5);
		}
		return callback();
	} finally {
		unlinkIfPresent(stagingPath);
		unlinkIfPresent(claimPath);
	}
}
