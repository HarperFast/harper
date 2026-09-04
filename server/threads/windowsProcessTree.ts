import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as harperLogger from '../../utility/logging/harper_logger.ts';

/**
 * Confirms that a spawned Windows process tree is gone, identifying its members by lifetime
 * rather than by PID alone.
 *
 * Windows recycles a freed PID almost immediately, and a process keeps its ParentProcessId after
 * that parent exits. So once the direct child (the tree root) has exited, `ProcessId == rootPid`
 * can be any newer process, and `ParentProcessId == rootPid` can be that newer process's children
 * — a scan keyed on the PID alone reports the tree alive for as long as the recycled PID stays in
 * use, and `taskkill /T` on that PID kills whatever now owns it (harper#2273). A real member's
 * creation time is bounded by its parent's lifetime, which is what `selectWindowsProcessTree`
 * checks: the root is only a member while it is the process we spawned, and a child of `X` was
 * created after `X` was and before `X` exited.
 */

export interface WindowsProcessRecord {
	pid: number;
	ppid: number;
	/** Win32_Process.CreationDate as epoch ms; null when Windows reports none (system processes). */
	created: number | null;
	name?: string;
}

export interface WindowsProcessTreeIdentity {
	rootPid: number;
	/** Epoch ms at which the root was already running: after spawn returned, or at group registration. */
	rootKnownAt: number;
	/**
	 * How long before `rootKnownAt` the root may have started: the interval measured around the
	 * `spawn` call, or `ROOT_SPAWN_ALLOWANCE_MS` when that was not measured. Bounds the children of
	 * a root whose own creation time was never observed.
	 */
	rootStartedWithinMs?: number;
	/** The root's own creation time, once a scan has seen it running as ours; the exact child bound. */
	rootCreatedAt?: number;
	/**
	 * Epoch ms after which the root was no longer running — Node observed its exit, a forced kill
	 * was confirmed, or a scan found its PID gone or recycled. Bounds its children's creation. Left
	 * undefined while it runs; `confirmWindowsProcessTreeGone` latches it from its own scans.
	 */
	rootExitedAt?: number;
	/**
	 * Every member below the root that a scan has found, by PID with its creation time, and the
	 * moment a later scan first found it gone. Kept so a member stays one after the parent that
	 * linked it to the root has exited, and so its own children stay bounded by its lifetime.
	 * `confirmWindowsProcessTreeGone` maintains it.
	 */
	descendants?: Map<number, WindowsTreeMemberRecord>;
}

export interface WindowsTreeMemberRecord {
	created: number;
	exitedAt?: number;
}

export interface WindowsProcessTreeWaitOptions {
	scan?: () => Promise<WindowsProcessRecord[] | null>;
	kill?: (members: WindowsProcessRecord[], rootPid: number) => Promise<void>;
	now?: () => number;
	warn?: (message: string) => void;
	pollMs?: number;
	maxPollMs?: number;
	/** Names the tree in the unconfirmed-termination warning. */
	label?: string;
}

// Date.now() and Win32_Process.CreationDate read the same system clock; this covers its resolution.
const CLOCK_SKEW_MS = 50;
// The root is created inside the `spawn` call, so the interval measured around that call is the
// exact bound on how much earlier than `rootKnownAt` it may have started. This is the fallback for a
// registration that carried no such interval: a stall between the two — an event loop pause, never
// a network hop.
export const ROOT_SPAWN_ALLOWANCE_MS = 1_000;
export const WINDOWS_TREE_POLL_MS = 25;
const WINDOWS_TREE_POLL_MAX_MS = 5_000;
const WINDOWS_TREE_WARNING_MS = 5_000;
const WINDOWS_TREE_WARNING_INTERVAL_MS = 60_000;

// Exit 0 means the query ran and produced a table (possibly empty — an empty table is still a
// positive result, not "unknown"); exit 2 means the query itself failed (e.g. Get-CimInstance
// denied or WMI unavailable), which ErrorActionPreference=Stop plus the wrapping try/catch turns
// into that distinct code instead of a false-empty result, and `queryWindowsProcessTable` reads
// anything but 0 as "could not read the table" (null), never as "positively found nothing".
const PROCESS_TABLE_SCRIPT =
	"$ErrorActionPreference = 'Stop'; try { " +
	'$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ' +
	'pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; ' +
	'created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null } } }); ' +
	'[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $rows)); exit 0 ' +
	'} catch { exit 2 }';

export function queryWindowsProcessTable(): Promise<WindowsProcessRecord[] | null> {
	return new Promise((resolve) => {
		const query = spawn(
			'powershell.exe',
			['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE_SCRIPT],
			{
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			}
		);
		let output = '';
		// utf8 so the decoder buffers a multi-byte character split across a chunk boundary — a
		// process name has arbitrary Unicode — instead of coercing each half's raw bytes separately
		query.stdout.setEncoding('utf8');
		query.stdout.on('data', (chunk) => {
			output += chunk;
		});
		query.once('close', (code) => resolve(code === 0 ? parseProcessTable(output) : null));
		query.once('error', () => resolve(null));
	});
}

export function parseProcessTable(json: string): WindowsProcessRecord[] | null {
	let rows: unknown;
	try {
		rows = JSON.parse(json.replace(/^\uFEFF/, ''));
	} catch {
		return null;
	}
	if (rows === null || typeof rows !== 'object') return null;
	const table: WindowsProcessRecord[] = [];
	for (const row of Array.isArray(rows) ? rows : [rows]) {
		const { pid, ppid, created, name } = (row ?? {}) as Record<string, unknown>;
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
		table.push({
			pid: pid as number,
			ppid: ppid as number,
			created: Number.isFinite(created) ? (created as number) : null,
			name: typeof name === 'string' ? name : undefined,
		});
	}
	return table;
}

export function findWindowsTreeRoot(
	table: WindowsProcessRecord[],
	identity: WindowsProcessTreeIdentity
): WindowsProcessRecord | undefined {
	if (identity.rootExitedAt !== undefined) return undefined;
	const root = table.find((process) => process.pid === identity.rootPid);
	if (root && root.created !== null && root.created <= identity.rootKnownAt + CLOCK_SKEW_MS) return root;
	return undefined;
}

/**
 * The processes in `table` that belong to the tree rooted at `identity.rootPid`. The root counts
 * only while it still runs and is the process we spawned (created no later than we first knew
 * it); a child counts only if it was created while its parent lived — after the root's own
 * creation where that was observed, and before its exit — so nothing that merely inherited a
 * recycled PID or ParentProcessId is included.
 */
export function selectWindowsProcessTree(
	table: WindowsProcessRecord[],
	identity: WindowsProcessTreeIdentity,
	now: number = Date.now()
): WindowsProcessRecord[] {
	const members: WindowsProcessRecord[] = [];
	const seen = new Set<number>([identity.rootPid]);
	const root = findWindowsTreeRoot(table, identity);
	if (root) members.push(root);
	const rootCreatedAt = root?.created ?? identity.rootCreatedAt;
	// A row now holding `pid` that could not possibly be the member we are bounding — created after
	// the latest moment a genuine one could have been — proves the PID was already recycled by then,
	// tighter than a "gone" conclusion that only arrives once a scan stops observing the member at
	// all (for a remembered descendant that can be a whole backed-off poll late; for the root, the
	// scan that first fails to find it still uses this frontier before its exit is stamped —
	// `confirmWindowsProcessTreeGone` below only latches `rootExitedAt` after this call returns).
	// `oursNoLaterThan` for a descendant is its exact known creation time; for the root it is the
	// latest creation `findWindowsTreeRoot` would still have accepted as ours, so a row this cannot
	// exonerate is never treated as a false impostor of a root we simply haven't re-confirmed yet.
	const impostorCreatedAt = (pid: number, oursNoLaterThan: number): number | undefined => {
		const impostor = table.find(
			(process) => process.pid === pid && process.created !== null && process.created > oursNoLaterThan
		);
		return impostor?.created;
	};
	let frontier = [
		{
			pid: identity.rootPid,
			notBefore:
				(rootCreatedAt === undefined || rootCreatedAt === null
					? identity.rootKnownAt - (identity.rootStartedWithinMs ?? ROOT_SPAWN_ALLOWANCE_MS)
					: rootCreatedAt) - CLOCK_SKEW_MS,
			notAfter:
				Math.min(
					identity.rootExitedAt ?? now,
					impostorCreatedAt(identity.rootPid, rootCreatedAt ?? identity.rootKnownAt + CLOCK_SKEW_MS) ?? Infinity
				) + CLOCK_SKEW_MS,
		},
	];
	// A member an earlier scan found is still one — by PID and creation time — after the parent
	// that linked it to the root has exited and left no row to walk through; its children are
	// bounded by its lifetime like any other member's, latched from the scan that first lost it.
	for (const [pid, known] of identity.descendants ?? []) {
		if (seen.has(pid)) continue;
		const live = table.find((process) => process.pid === pid && process.created === known.created);
		if (live) {
			seen.add(pid);
			members.push(live);
			frontier.push({ pid, notBefore: known.created - CLOCK_SKEW_MS, notAfter: Infinity });
		} else {
			frontier.push({
				pid,
				notBefore: known.created - CLOCK_SKEW_MS,
				notAfter: Math.min(known.exitedAt ?? now, impostorCreatedAt(pid, known.created) ?? Infinity) + CLOCK_SKEW_MS,
			});
		}
	}
	while (frontier.length > 0) {
		const next: typeof frontier = [];
		for (const parent of frontier) {
			for (const process of table) {
				if (process.ppid !== parent.pid || seen.has(process.pid) || process.created === null) continue;
				if (process.created < parent.notBefore || process.created > parent.notAfter) continue;
				seen.add(process.pid);
				members.push(process);
				next.push({ pid: process.pid, notBefore: process.created - CLOCK_SKEW_MS, notAfter: Infinity });
			}
		}
		frontier = next;
	}
	return members;
}

/**
 * The taskkill argument list that terminates `members`: the whole tree through the root while the
 * root itself is still ours — never also by descendant PID in the same round, since `/T` frees
 * those PIDs before a second invocation could run — and otherwise every member by its own PID,
 * which is safe only because the root's PID is then no longer ours to `/T`.
 */
export function taskkillInvocation(members: WindowsProcessRecord[], rootPid: number): string[] | null {
	if (members.length === 0) return null;
	if (members.some((member) => member.pid === rootPid)) return ['/pid', String(rootPid), '/T', '/F'];
	return ['/F', ...members.flatMap((member) => ['/pid', String(member.pid)])];
}

function runTaskkill(args: string[]): Promise<void> {
	return new Promise((resolve) => {
		const taskkill = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
		taskkill.once('close', () => resolve());
		taskkill.once('error', () => resolve());
	});
}

async function killWindowsProcesses(members: WindowsProcessRecord[], rootPid: number): Promise<void> {
	const args = taskkillInvocation(members, rootPid);
	if (args) await runTaskkill(args);
}

function rememberDescendants(identity: WindowsProcessTreeIdentity, members: WindowsProcessRecord[], scannedAt: number) {
	const descendants = (identity.descendants ??= new Map());
	for (const member of members) {
		if (member.pid === identity.rootPid || member.created === null) continue;
		if (descendants.get(member.pid)?.created !== member.created)
			descendants.set(member.pid, { created: member.created });
	}
	for (const [pid, known] of descendants) {
		if (known.exitedAt !== undefined) continue;
		if (!members.some((member) => member.pid === pid && member.created === known.created)) known.exitedAt = scannedAt;
	}
}

function describeMembers(members: WindowsProcessRecord[]): string {
	return members
		.map(
			(member) =>
				`${member.pid}${member.name ? ` (${member.name})` : ''} created ${member.created === null ? 'unknown' : new Date(member.created).toISOString()}`
		)
		.join(', ');
}

/**
 * Terminate every remaining member of the tree and resolve once a scan positively finds none.
 * There is deliberately no deadline: releasing a component's preparation lock while a descendant
 * can still mutate its directory is less safe than keeping that deployment wedged for operator
 * intervention — but the wait is logged, so a wedge names the process holding it, and the poll
 * backs off so a wedge does not spin the process table query. A scan that cannot read the table
 * (null) is unknown, not gone, and keeps the wait going.
 */
export async function confirmWindowsProcessTreeGone(
	identity: WindowsProcessTreeIdentity,
	options: WindowsProcessTreeWaitOptions = {}
): Promise<void> {
	const scan = options.scan ?? queryWindowsProcessTable;
	const kill = options.kill ?? killWindowsProcesses;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => harperLogger.warn(message));
	const maxPollMs = options.maxPollMs ?? WINDOWS_TREE_POLL_MAX_MS;
	let pollMs = options.pollMs ?? WINDOWS_TREE_POLL_MS;
	const label = options.label ?? `pid ${identity.rootPid}`;
	const startedAt = now();
	let nextWarningAt = startedAt + WINDOWS_TREE_WARNING_MS;
	for (;;) {
		const table = await scan();
		let members: WindowsProcessRecord[] | null = null;
		if (table !== null) {
			const scannedAt = now();
			const root = findWindowsTreeRoot(table, identity);
			const rootIdentityUnknown =
				identity.rootExitedAt === undefined &&
				table.some((process) => process.pid === identity.rootPid && process.created === null);
			if (!rootIdentityUnknown) {
				if (root && identity.rootCreatedAt === undefined) identity.rootCreatedAt = root.created;
				members = selectWindowsProcessTree(table, identity, scannedAt);
				// The root's PID is reusable the moment it exits, so from the first scan that no longer finds
				// it running as ours, nothing created later can be its child. Stamped after the scan: the
				// snapshot may predate the stamp, and a bound that is late keeps waiting, which is the safe
				// direction. The same goes for every other member.
				if (!root && identity.rootExitedAt === undefined) identity.rootExitedAt = scannedAt;
				rememberDescendants(identity, members, scannedAt);
			}
		}
		if (members?.length === 0) return;
		if (members) await kill(members, identity.rootPid);
		const time = now();
		if (time >= nextWarningAt) {
			warn(
				`Termination of the process tree of ${label} remains unconfirmed after ${Math.round(time - startedAt)}ms: ` +
					(members ? `live members ${describeMembers(members)}` : 'the Windows process table could not be queried')
			);
			nextWarningAt = time + WINDOWS_TREE_WARNING_INTERVAL_MS;
		}
		await delay(pollMs);
		pollMs = Math.min(pollMs * 2, maxPollMs);
	}
}
