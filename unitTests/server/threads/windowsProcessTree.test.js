'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');

const {
	confirmWindowsProcessTreeGone,
	parseProcessTable,
	queryWindowsProcessTable,
	selectWindowsProcessTree,
	taskkillInvocation,
} = require('#src/server/threads/windowsProcessTree');

// The Windows process-tree confirmation behind component installs (Application.ts) and dead-worker
// process-group reclamation (manageThreads.js). Windows recycles a freed PID almost immediately and
// a process keeps its ParentProcessId after that parent exits, so membership is decided by lifetime
// rather than by PID alone. These tests drive the selection and the wait loop with synthetic
// process tables; the last group runs the real PowerShell query, on Windows only.

const ROOT = 4000;
const SPAWNED_AT = 1_000_000;
const EXITED_AT = SPAWNED_AT + 700;

function row(pid, ppid, created, name = 'node.exe') {
	return { pid, ppid, created, name };
}

function pids(members) {
	return members.map((member) => member.pid).sort((a, b) => a - b);
}

describe('selectWindowsProcessTree', () => {
	it('keeps a descendant chain created during the root lifetime after the root has exited', () => {
		const table = [
			row(ROOT, 1, SPAWNED_AT + 5, 'cmd.exe'),
			row(4100, ROOT, SPAWNED_AT + 200),
			row(4200, 4100, EXITED_AT + 5_000, 'conhost.exe'),
		];
		const members = selectWindowsProcessTree(table, {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
		});
		assert.deepEqual(pids(members), [4100, 4200]);
	});

	it('ignores a process that recycled the exited root PID, and its children', () => {
		const table = [
			row(ROOT, 900, EXITED_AT + 30, 'WmiPrvSE.exe'),
			row(5100, ROOT, EXITED_AT + 60),
			row(5200, 5100, EXITED_AT + 90),
		];
		const members = selectWindowsProcessTree(table, {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
		});
		assert.deepEqual(members, []);
	});

	it('ignores an older process whose stale ParentProcessId is a PID our root later received', () => {
		const orphans = [
			row(6000, ROOT, SPAWNED_AT - 1_200, 'orphan.exe'),
			row(6100, ROOT, SPAWNED_AT - 30_000, 'orphan.exe'),
			row(6200, ROOT, SPAWNED_AT - 600_000, 'older.exe'),
		];
		const spawnLocal = { rootPid: ROOT, rootKnownAt: SPAWNED_AT, rootStartedWithinMs: 1_000, rootExitedAt: EXITED_AT };
		assert.deepEqual(selectWindowsProcessTree(orphans, spawnLocal), []);
		// the interval measured around the spawn call is the exact allowance: an orphan from half a
		// second before the spawn returned is the previous owner's, not ours
		const measured = { ...spawnLocal, rootStartedWithinMs: 3 };
		const recent = row(6300, ROOT, SPAWNED_AT - 500, 'orphan.exe');
		assert.deepEqual(selectWindowsProcessTree([recent, ...orphans], measured), []);
		assert.deepEqual(pids(selectWindowsProcessTree([recent, ...orphans], spawnLocal)), [6300]);
		// a wider allowance admits the youngest orphan
		const registered = { ...spawnLocal, rootStartedWithinMs: 5_000 };
		assert.deepEqual(pids(selectWindowsProcessTree(orphans, registered)), [6000]);
		// unless the root's own creation time is known, which is the exact bound
		assert.deepEqual(selectWindowsProcessTree(orphans, { ...registered, rootCreatedAt: SPAWNED_AT - 900 }), []);
	});

	it('bounds direct children by the root row itself while it is still running', () => {
		const table = [
			row(ROOT, 1, SPAWNED_AT - 900, 'cmd.exe'),
			row(6000, ROOT, SPAWNED_AT - 1_200),
			row(4100, ROOT, SPAWNED_AT - 800),
		];
		const members = selectWindowsProcessTree(
			table,
			{ rootPid: ROOT, rootKnownAt: SPAWNED_AT, rootStartedWithinMs: 5_000 },
			EXITED_AT
		);
		assert.deepEqual(pids(members), [ROOT, 4100]);
	});

	it('counts the root itself only while it runs and is the process we spawned', () => {
		const ours = [row(ROOT, 1, SPAWNED_AT - 300, 'cmd.exe')];
		assert.deepEqual(pids(selectWindowsProcessTree(ours, { rootPid: ROOT, rootKnownAt: SPAWNED_AT }, EXITED_AT)), [
			ROOT,
		]);
		const recycled = [row(ROOT, 1, SPAWNED_AT + 5_000, 'cmd.exe')];
		assert.deepEqual(selectWindowsProcessTree(recycled, { rootPid: ROOT, rootKnownAt: SPAWNED_AT }, EXITED_AT), []);
		// once its exit is known, even a row still showing our creation time is a process on its way out
		assert.deepEqual(
			selectWindowsProcessTree(ours, { rootPid: ROOT, rootKnownAt: SPAWNED_AT, rootExitedAt: EXITED_AT }),
			[]
		);
	});

	it('does not treat a root without a creation time as the process we spawned', () => {
		const members = selectWindowsProcessTree([row(ROOT, 1, null, 'cmd.exe')], {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
		});
		assert.deepEqual(members, []);
	});

	it('bounds a still-running root only by the current time', () => {
		const table = [row(ROOT, 1, SPAWNED_AT - 5, 'cmd.exe'), row(4100, ROOT, SPAWNED_AT + 90_000)];
		const members = selectWindowsProcessTree(table, { rootPid: ROOT, rootKnownAt: SPAWNED_AT }, SPAWNED_AT + 100_000);
		assert.deepEqual(pids(members), [ROOT, 4100]);
	});

	it('does not admit a child created before its parent (a recycled parent PID at depth)', () => {
		const table = [row(4100, ROOT, SPAWNED_AT + 200), row(4200, 4100, SPAWNED_AT - 5_000)];
		const members = selectWindowsProcessTree(table, {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
		});
		assert.deepEqual(pids(members), [4100]);
	});

	it('keeps a member an earlier scan recorded, and its children, after the parent linking it to the root exited', () => {
		const grandchild = row(4200, 4100, SPAWNED_AT + 300);
		const identity = {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
			descendants: new Map([[4100, { created: SPAWNED_AT + 200, exitedAt: EXITED_AT + 100 }]]),
		};
		// 4100 is gone from the table, so nothing links 4200 to the root any more
		assert.deepEqual(pids(selectWindowsProcessTree([grandchild], identity)), [4200]);
		// a process whose parent PID was recycled after that member exited is not its child
		const stranger = row(4300, 4100, EXITED_AT + 5_000);
		assert.deepEqual(pids(selectWindowsProcessTree([grandchild, stranger], identity)), [4200]);
		// a recorded member still running is one by PID and creation time, never by PID alone
		const recycled = row(4100, 1, EXITED_AT + 1_000, 'other.exe');
		assert.deepEqual(pids(selectWindowsProcessTree([recycled, grandchild], identity)), [4200]);
		const stillRunning = row(4100, ROOT, SPAWNED_AT + 200);
		const live = { ...identity, descendants: new Map([[4100, { created: SPAWNED_AT + 200 }]]) };
		assert.deepEqual(pids(selectWindowsProcessTree([stillRunning, grandchild], live)), [4100, 4200]);
	});

	it('bounds an exited member by the row that replaced its PID, not only by the scan that lost it', () => {
		// the member exited at +1000, its PID was recycled at +2000 and the new owner spawned a child
		// at +3000; the scan that first misses the member runs at +5000 after a backed-off poll
		const replacement = row(4100, 1, SPAWNED_AT + 2_000, 'other.exe');
		const strangersChild = row(4300, 4100, SPAWNED_AT + 3_000);
		const ours = row(4200, 4100, SPAWNED_AT + 900);
		const identity = {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
			descendants: new Map([[4100, { created: SPAWNED_AT + 200 }]]),
		};
		const table = [replacement, strangersChild, ours];
		assert.deepEqual(pids(selectWindowsProcessTree(table, identity, SPAWNED_AT + 5_000)), [4200]);
		assert.deepEqual(
			pids(
				selectWindowsProcessTree(table, {
					...identity,
					descendants: new Map([[4100, { created: SPAWNED_AT + 200, exitedAt: SPAWNED_AT + 5_000 }]]),
				})
			),
			[4200]
		);
	});

	it("bounds the root's own children by a visibly recycled root PID, on the very scan that first misses it", () => {
		// this is the scan `confirmWindowsProcessTreeGone` uses to decide whether to stamp rootExitedAt
		// afterward — rootExitedAt is not yet set, so notAfter cannot fall back to it here
		const identity = { rootPid: ROOT, rootKnownAt: SPAWNED_AT };
		// created well outside CLOCK_SKEW_MS of rootKnownAt: findWindowsTreeRoot rejects it as ours
		const impostor = row(ROOT, 900, SPAWNED_AT + 5_000, 'WmiPrvSE.exe');
		const impostorsChild = row(5100, ROOT, SPAWNED_AT + 6_000);
		assert.deepEqual(selectWindowsProcessTree([impostor, impostorsChild], identity, SPAWNED_AT + 6_500), []);
		// a row within CLOCK_SKEW_MS of rootKnownAt is ambiguous (it satisfies findWindowsTreeRoot's own
		// acceptance test), so it is never treated as evidence the root already exited
		const ambiguous = row(ROOT, 1, SPAWNED_AT + 5, 'cmd.exe');
		const itsChild = row(4100, ROOT, SPAWNED_AT + 200);
		assert.deepEqual(pids(selectWindowsProcessTree([ambiguous, itsChild], identity, SPAWNED_AT + 300)), [ROOT, 4100]);
	});

	it('never attributes a process without a creation time to the tree', () => {
		const table = [row(4100, ROOT, null)];
		const members = selectWindowsProcessTree(table, {
			rootPid: ROOT,
			rootKnownAt: SPAWNED_AT,
			rootExitedAt: EXITED_AT,
		});
		assert.deepEqual(members, []);
	});
});

describe('taskkillInvocation', () => {
	it('kills through the root alone while the root is a member, and every member by its own PID once it is not', () => {
		const child = row(4100, ROOT, SPAWNED_AT + 200);
		const grandchild = row(4200, 4100, SPAWNED_AT + 300);
		// /T frees the descendants' PIDs, so a same-round per-PID kill could hit whatever recycled them
		assert.deepEqual(taskkillInvocation([row(ROOT, 1, SPAWNED_AT), child, grandchild], ROOT), [
			'/pid',
			String(ROOT),
			'/T',
			'/F',
		]);
		assert.deepEqual(taskkillInvocation([child, grandchild], ROOT), ['/F', '/pid', '4100', '/pid', '4200']);
		assert.equal(taskkillInvocation([], ROOT), null);
	});
});

describe('parseProcessTable', () => {
	it('reads the rows the PowerShell query emits and rejects anything else', () => {
		assert.deepEqual(
			parseProcessTable(
				'[{"pid":4,"ppid":0,"name":"System","created":null},{"pid":7,"ppid":4,"name":"a.exe","created":12}]'
			),
			[
				{ pid: 4, ppid: 0, created: null, name: 'System' },
				{ pid: 7, ppid: 4, created: 12, name: 'a.exe' },
			]
		);
		assert.deepEqual(parseProcessTable('﻿[{"pid":1,"ppid":0}]'), [{ pid: 1, ppid: 0, created: null, name: undefined }]);
		assert.deepEqual(parseProcessTable('{"pid":1,"ppid":0,"created":5}'), [
			{ pid: 1, ppid: 0, created: 5, name: undefined },
		]);
		assert.deepEqual(parseProcessTable('[]'), []);
		assert.equal(parseProcessTable('not json'), null);
		assert.equal(parseProcessTable('"text"'), null);
		assert.equal(parseProcessTable('[{"pid":"1","ppid":0}]'), null);
	});
});

describe('confirmWindowsProcessTreeGone', () => {
	const exitedIdentity = () => ({ rootPid: ROOT, rootKnownAt: SPAWNED_AT, rootExitedAt: EXITED_AT });

	it('terminates the members each scan finds and returns only once a scan finds none', async () => {
		const child = row(4100, ROOT, SPAWNED_AT + 200);
		const scans = [[child], [child], []];
		const kills = [];
		await confirmWindowsProcessTreeGone(exitedIdentity(), {
			scan: async () => scans.shift(),
			kill: async (members, rootPid) => kills.push([pids(members), rootPid]),
			pollMs: 1,
		});
		assert.deepEqual(kills, [
			[[4100], ROOT],
			[[4100], ROOT],
		]);
		assert.equal(scans.length, 0);
	});

	it('keeps waiting on a grandchild after the root and its parent both exited between scans', async () => {
		const child = row(4100, ROOT, SPAWNED_AT + 200);
		const grandchild = row(4200, 4100, SPAWNED_AT + 300);
		const identity = exitedIdentity();
		const scans = [[child, grandchild], [grandchild], [grandchild], []];
		const kills = [];
		await confirmWindowsProcessTreeGone(identity, {
			scan: async () => scans.shift(),
			kill: async (members) => kills.push(pids(members)),
			pollMs: 1,
		});
		assert.deepEqual(kills, [[4100, 4200], [4200], [4200]]);
		assert.equal(scans.length, 0);
		assert.equal(identity.descendants.get(4100).created, SPAWNED_AT + 200);
		assert.ok(identity.descendants.get(4100).exitedAt !== undefined, 'the exited parent is bounded');
		assert.ok(identity.descendants.get(4200).exitedAt !== undefined);
	});

	it('treats an unreadable process table as unknown, not gone', async () => {
		const scans = [null, null, []];
		let kills = 0;
		await confirmWindowsProcessTreeGone(exitedIdentity(), {
			scan: async () => scans.shift(),
			kill: async () => kills++,
			pollMs: 1,
		});
		assert.equal(scans.length, 0);
		assert.equal(kills, 0);
	});

	it('waits for a root with an unknown creation time to disappear before confirming its tree is gone', async () => {
		const scans = [[row(ROOT, 1, null, 'cmd.exe')], []];
		await confirmWindowsProcessTreeGone(
			{ rootPid: ROOT, rootKnownAt: SPAWNED_AT },
			{
				scan: async () => scans.shift(),
				kill: async () => assert.fail('an unverified root must not be killed'),
				pollMs: 1,
			}
		);
		assert.equal(scans.length, 0);
	});

	it('keeps terminating descendants whose identities were verified before the root became unknown', async () => {
		const child = row(4100, ROOT, SPAWNED_AT + 200);
		const scans = [[row(ROOT, 1, SPAWNED_AT - 10, 'cmd.exe'), child], [row(ROOT, 1, null, 'cmd.exe'), child], []];
		const kills = [];
		await confirmWindowsProcessTreeGone(
			{ rootPid: ROOT, rootKnownAt: SPAWNED_AT },
			{
				scan: async () => scans.shift(),
				kill: async (members) => kills.push(pids(members)),
				pollMs: 1,
			}
		);
		assert.deepEqual(kills, [[ROOT, 4100], [4100]]);
		assert.equal(scans.length, 0);
	});

	it('does not wait on a process that merely recycled the exited root PID', async () => {
		let scans = 0;
		await confirmWindowsProcessTreeGone(exitedIdentity(), {
			scan: async () => {
				scans++;
				return [row(ROOT, 900, EXITED_AT + 30, 'WmiPrvSE.exe'), row(5100, ROOT, EXITED_AT + 60)];
			},
			kill: async () => assert.fail('nothing to kill'),
			pollMs: 1,
		});
		assert.equal(scans, 1);
	});

	it('keeps terminating a root whose exit was never observed while it is still found running as ours', async () => {
		// manageThreads' path: the synchronous taskkill was not confirmed, so the root may still be up.
		const identity = { rootPid: ROOT, rootKnownAt: SPAWNED_AT };
		const root = row(ROOT, 1, SPAWNED_AT - 10, 'cmd.exe');
		const child = row(4100, ROOT, SPAWNED_AT + 200);
		let clock = SPAWNED_AT + 1_000;
		const scans = [[root, child], [child], []];
		const kills = [];
		await confirmWindowsProcessTreeGone(identity, {
			scan: async () => scans.shift(),
			kill: async (members, rootPid) => kills.push(taskkillInvocation(members, rootPid)),
			now: () => (clock += 100),
			pollMs: 1,
		});
		assert.deepEqual(kills, [
			['/pid', String(ROOT), '/T', '/F'],
			['/F', '/pid', '4100'],
		]);
		// the exit was latched from the first scan that no longer found the root, so a process that
		// recycles its PID afterwards is never mistaken for it
		assert.ok(
			identity.rootExitedAt >= SPAWNED_AT + 1_000 && identity.rootExitedAt < clock,
			String(identity.rootExitedAt)
		);
		assert.equal(identity.rootCreatedAt, SPAWNED_AT - 10);
	});

	it('latches the root exit after the scan, so a child born during that scan is still waited on', async () => {
		const identity = { rootPid: ROOT, rootKnownAt: SPAWNED_AT };
		let clock = SPAWNED_AT + 1_000;
		let lateChild;
		const scans = [
			async () => {
				// the snapshot is taken early in a slow scan; the root exits and a last child appears after it
				clock += 2_000;
				lateChild = row(4100, ROOT, clock - 500);
				return [lateChild];
			},
			async () => [lateChild],
			async () => [],
		];
		const kills = [];
		await confirmWindowsProcessTreeGone(identity, {
			scan: () => scans.shift()(),
			kill: async (members) => kills.push(pids(members)),
			now: () => (clock += 100),
			pollMs: 1,
		});
		assert.deepEqual(kills, [[4100], [4100]]);
	});

	it('names the survivors once the wait is long enough to be a problem, and backs off its polling', async () => {
		const survivor = row(4100, ROOT, SPAWNED_AT + 200, 'node.exe');
		let clock = SPAWNED_AT;
		const warnings = [];
		let remaining = 3;
		const started = Date.now();
		await confirmWindowsProcessTreeGone(exitedIdentity(), {
			scan: async () => {
				clock += 4_000;
				return remaining-- > 0 ? [survivor] : [];
			},
			kill: async () => {},
			now: () => clock,
			warn: (message) => warnings.push(message),
			pollMs: 5,
			maxPollMs: 20,
			label: 'npm.cmd install',
		});
		assert.equal(warnings.length, 1, warnings.join('\n'));
		assert.match(
			warnings[0],
			/process tree of npm\.cmd install remains unconfirmed after \d+ms: live members 4100 \(node\.exe\) created 1970-/
		);
		// 5 + 10 + 20 ms of polling between four scans, doubling to the cap
		assert.ok(Date.now() - started >= 30, `polls should back off: ${Date.now() - started}ms`);
	});
});

describe('queryWindowsProcessTable', function () {
	before(function () {
		if (process.platform !== 'win32') this.skip();
	});

	it('lists a spawned child with a creation time bracketed by the spawn, and the tree confirms gone once killed', async function () {
		this.timeout(60_000);
		const before = Date.now();
		const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		const identity = { rootPid: child.pid, rootKnownAt: Date.now() };
		child.on('exit', () => {
			identity.rootExitedAt = Date.now();
		});
		const table = await queryWindowsProcessTable();
		assert.ok(Array.isArray(table), 'the process table query should succeed on Windows');
		assert.ok(
			table.some((process) => process.pid === require('node:process').pid),
			'the current process should be in the table'
		);
		const spawned = table.find((process) => process.pid === child.pid);
		assert.ok(spawned, 'the spawned child should be in the table');
		assert.ok(
			spawned.created !== null && spawned.created >= before - 5_000 && spawned.created <= Date.now() + 50,
			`creation time ${spawned.created} should sit between ${before} and now`
		);
		// Windows gives a console process its own conhost.exe child, so the tree is the spawned
		// child plus whatever it parents — every member must chain back to it.
		const members = selectWindowsProcessTree(table, identity);
		const memberPids = new Set(pids(members));
		assert.ok(memberPids.has(child.pid), `the spawned child should be a member: ${JSON.stringify(members)}`);
		for (const member of members) {
			assert.ok(
				member.pid === child.pid || memberPids.has(member.ppid),
				`member ${member.pid} (${member.name}) does not descend from the spawned child: ${JSON.stringify(members)}`
			);
		}
		await confirmWindowsProcessTreeGone(identity, { label: 'unit test child' });
		assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child should have been terminated');
	});
});
