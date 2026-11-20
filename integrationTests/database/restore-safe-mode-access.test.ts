/**
 * Restore safe mode and the access boundary (docs/reference/backups/operations.md: "Restoring at the next
 * startup", "Failed attempts", "Restore safe mode").
 *
 * While a restart restore has taken its pre-restore backup and has not published, Harper starts without loading
 * any component, the database being restored is not loaded, and the operations API keeps running so a super_user
 * can finish or withdraw the restore. The suite drives one data directory through three boots:
 *   boot 1  normal: the component serves a restricted value only to permitted principals; a managed backup is
 *           taken, the live value is changed, and the backup is scheduled with on_restart=true (Harper exits);
 *   boot 2  the backup's manifest is set aside first, so the startup's attempt fails after its pre-restore
 *           backup and Harper holds itself in restore safe mode;
 *   boot 3  the manifest is put back and a super_user resumes the restore: it publishes, the component loads.
 * In boot 2 no application route answers for anyone, neither generation of the restricted value leaves through
 * the operations API, the untouched database keeps its role and attribute permissions, no component or preload
 * code runs, and every non-super_user request to finish, withdraw or replace the restore, or to read or change
 * its backups, is refused with nothing changed. Boots 1 and 3 are the positive control for each of those checks:
 * the same probes return the value there, and the same `resume` from a super_user is accepted.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'restore-safe-mode-access');
const PRELOAD_PATH = resolve(import.meta.dirname, 'restore-safe-mode-access-preload/preload.mjs');
const PRELOAD_REQUIRE_PATH = resolve(import.meta.dirname, 'restore-safe-mode-access-preload/preload-require.cjs');
const HELD = 'restore_safe_mode';
const OTHER = 'restore_safe_mode_other';
const MARK_BACKED_UP = 'safe-mode-backed-up-41c9';
const MARK_LIVE = 'safe-mode-live-9d27';
const MARK_OTHER = 'safe-mode-other-b60e';
const MARKS = [MARK_BACKED_UP, MARK_LIVE, MARK_OTHER];
// not restricted, but a row of the database being restored carries it whichever generation it is
const HELD_OWNER = 'acme-held';
const OTHER_OWNER = 'acme-other';
const RESTORE_SAFE_MODE_LOG = 'has not published, so this boot starts in safe mode and loads no component';
const JOB_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 90_000;
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const PRINCIPALS = ['anonymous', 'nogrant', 'reader', 'auditor', 'opslist', 'admin'] as const;
type Principal = (typeof PRINCIPALS)[number];
const NON_SUPER = PRINCIPALS.filter((p) => p !== 'admin');
const PASSWORD = 'Placeholder-pw-1!';

type Probe = { status: number; text: string; marks: string[] };
type Matrix = Record<string, Record<Principal, Probe>>;
type Observation = {
	rest: Matrix;
	ops: Matrix;
	bootRows: number;
	/** `form:pid:threadId:HARPER_SAFE_MODE` lines written by THIS boot's process (a job thread of an earlier boot can add lines late) */
	preloadLines: string[];
	announcements: number;
};

suite('restore safe mode keeps the access boundary', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let workDir: string;
	let preloadOut: string;
	let OPTIONS: Parameters<typeof startHarper>[1];

	function headers(principal: Principal): Record<string, string> {
		const base: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
		if (principal === 'anonymous') return base;
		const { username, password } =
			principal === 'admin' ? ctx.harper.admin : { username: principal, password: PASSWORD };
		return { ...base, Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') };
	}

	async function request(url: string, principal: Principal, body?: unknown): Promise<Probe> {
		const res = await fetch(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers: headers(principal),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		return { status: res.status, text, marks: MARKS.filter((mark) => text.includes(mark)) };
	}

	const op = (principal: Principal, body: Record<string, unknown>) =>
		request(ctx.harper.operationsAPIURL, principal, body);

	const REST_PROBES: Record<string, { path: string; body?: unknown }> = {
		heldById: { path: '/SafeModeLedger/1' },
		heldCollection: { path: '/SafeModeLedger/' },
		heldGuarded: { path: '/SafeModeGuarded/1' },
		otherById: { path: '/SafeModeOther/1' },
		graphqlHeld: { path: '/graphql', body: { query: '{ SafeModeLedger { id owner secret } }' } },
		graphqlOther: { path: '/graphql', body: { query: '{ SafeModeOther { id owner secret } }' } },
	};
	const searchById = (database: string, table: string) => ({
		operation: 'search_by_id',
		database,
		table,
		ids: ['1'],
		get_attributes: ['*'],
	});
	const OPS_PROBES: Record<string, Record<string, unknown>> = {
		heldSearch: searchById(HELD, 'SafeModeLedger'),
		heldSql: { operation: 'sql', sql: `SELECT * FROM ${HELD}.SafeModeLedger` },
		heldDescribe: { operation: 'describe_database', database: HELD },
		otherSearch: searchById(OTHER, 'SafeModeOther'),
		otherSql: { operation: 'sql', sql: `SELECT * FROM ${OTHER}.SafeModeOther` },
	};

	// A restarted instance can keep writing to the log directory of an earlier boot, so the oracle counts the
	// announcement across every directory this suite's boots were given.
	const logDirs = new Set<string>();
	function logText(): string {
		if (ctx.harper.logDir) logDirs.add(ctx.harper.logDir);
		const files = [...logDirs].map((dir) => join(dir, 'hdb.log'));
		files.push(join(ctx.harper.dataRootDir, 'log', 'hdb.log'));
		return [...new Set(files)]
			.filter((file) => existsSync(file))
			.map((file) => readFileSync(file, 'utf8'))
			.join('\n');
	}
	const announcementCount = () => logText().split(RESTORE_SAFE_MODE_LOG).length - 1;

	// log writes are buffered: wait for the count to move, and give a boot that should not announce the same time
	async function announcementsAfterSettling(expectedAtLeast: number): Promise<number> {
		const deadline = Date.now() + 8_000;
		let count = announcementCount();
		while (count < expectedAtLeast && Date.now() < deadline) {
			await sleep(250);
			count = announcementCount();
		}
		if (count < expectedAtLeast)
			throw new Error(
				`hdb.log carries ${count} restore safe mode announcement(s), expected at least ${expectedAtLeast}`
			);
		await sleep(1_000);
		return announcementCount();
	}

	async function observe(expectedAnnouncements: number): Promise<Observation> {
		const rest: Matrix = {};
		for (const [name, probe] of Object.entries(REST_PROBES)) {
			rest[name] = {} as Record<Principal, Probe>;
			for (const principal of PRINCIPALS)
				rest[name][principal] = await request(ctx.harper.httpURL + probe.path, principal, probe.body);
		}
		const ops: Matrix = {};
		for (const [name, body] of Object.entries(OPS_PROBES)) {
			ops[name] = {} as Record<Principal, Probe>;
			for (const principal of PRINCIPALS) ops[name][principal] = await op(principal, body);
		}
		const boot = await op('admin', {
			operation: 'search_by_value',
			database: OTHER,
			table: 'SafeModeBoot',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		});
		strictEqual(boot.status, 200, `SafeModeBoot read: ${boot.text}`);
		return {
			rest,
			ops,
			bootRows: JSON.parse(boot.text).length,
			preloadLines: readFileSync(preloadOut, 'utf8')
				.split('\n')
				.filter((line) => line.split(':')[1] === String(ctx.harper.process.pid)),
			announcements: await announcementsAfterSettling(expectedAnnouncements),
		};
	}

	const cell = (probe: Probe) => `${probe.status}${probe.marks.length ? '+' + probe.marks.join('+') : ''}`;
	const table = (matrix: Matrix) =>
		Object.fromEntries(
			Object.entries(matrix).map(([name, by]) => [name, Object.fromEntries(PRINCIPALS.map((p) => [p, cell(by[p])]))])
		);
	const summary = (o: Observation) => ({
		rest: table(o.rest),
		ops: table(o.ops),
		bootRows: o.bootRows,
		preloadLines: o.preloadLines.length,
		announcements: o.announcements,
	});

	async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		let last: unknown;
		while (Date.now() < deadline) {
			try {
				const value = await probe();
				if (value !== undefined) return value;
			} catch (error) {
				last = error;
			}
			await sleep(250);
		}
		throw new Error(`${what} did not happen within ${timeoutMs}ms; last error: ${last}`);
	}

	const untilOperationsAnswer = () =>
		until('the operations API answering', JOB_TIMEOUT_MS, async () =>
			(await op('admin', { operation: 'user_info' })).status === 200 ? true : undefined
		);
	const untilRouteServed = () =>
		until('/SafeModeOther/ being served', JOB_TIMEOUT_MS, async () =>
			(await request(`${ctx.harper.httpURL}/SafeModeOther/`, 'admin')).status !== 404 ? true : undefined
		);

	function startedJob(started: Probe): string {
		strictEqual(started.status, 200, started.text);
		const jobId = /Starting job with id ([\w-]+)/.exec(JSON.parse(started.text)?.message ?? '')?.[1];
		ok(jobId, `no job id in ${started.text}`);
		return jobId;
	}
	async function job(jobId: string): Promise<any> {
		const r = await op('admin', { operation: 'get_job', id: jobId });
		strictEqual(r.status, 200, r.text);
		const parsed = JSON.parse(r.text);
		return Array.isArray(parsed) ? parsed[0] : parsed;
	}
	const settledJob = (jobId: string) =>
		until(`job ${jobId} settling`, JOB_TIMEOUT_MS, async () => {
			const record = await job(jobId);
			return record?.status === 'COMPLETE' || record?.status === 'ERROR' ? record : undefined;
		});

	function exitOf(proc: ContextWithHarper['harper']['process']): Promise<void> {
		return new Promise<void>((resolveExit, reject) => {
			if (proc.exitCode !== null || proc.signalCode !== null) return resolveExit();
			const timer = setTimeout(
				() => reject(new Error(`Harper did not exit within ${EXIT_TIMEOUT_MS}ms`)),
				EXIT_TIMEOUT_MS
			);
			proc.once('exit', () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
	}
	const running = () => ctx.harper.process.exitCode === null && ctx.harper.process.signalCode === null;

	function filesUnder(dir: string, match: (path: string) => boolean, found: string[] = []): string[] {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// component and dependency trees hold no restore or backup metadata
				if (entry.name !== 'node_modules' && entry.name !== 'components') filesUnder(path, match, found);
			} else if (match(path)) found.push(path);
		}
		return found;
	}
	const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

	async function restoreState(jobId: string) {
		const receipts = filesUnder(ctx.harper.dataRootDir, (path) => path.endsWith('.intent'));
		const repository = filesUnder(ctx.harper.dataRootDir, (path) => /[\\/]backup[\\/]/.test(path))
			.filter((path) => /[\\/](manifests|pins)[\\/]/.test(path))
			.sort();
		return {
			receipts: Object.fromEntries(receipts.sort().map((file) => [file, sha256(file)])),
			repository,
			jobStatus: (await job(jobId))?.status,
			running: running(),
			pid: ctx.harper.process.pid,
		};
	}

	async function roles(): Promise<unknown> {
		const r = await op('admin', { operation: 'list_roles' });
		strictEqual(r.status, 200, r.text);
		return (JSON.parse(r.text) as any[])
			.map(({ role, permission }) => ({ role, permission }))
			.sort((a, b) => String(a.role).localeCompare(String(b.role)));
	}

	let backupId: number;
	let manifestPath: string;
	let controlRoles: unknown;
	let restoreJobId: string;
	let control: Observation;
	let safeMode: Observation;

	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), 'restore-safe-mode-'));
		preloadOut = join(workDir, 'preload.log');
		writeFileSync(preloadOut, '');
		OPTIONS = {
			config: {
				threads: { count: 2, preload: PRELOAD_PATH, preloadRequire: PRELOAD_REQUIRE_PATH },
				authentication: { authorizeLocal: false },
				// 'error' also records notify lines: notify is the highest level, so 'notify' would drop the error lines
				logging: { level: 'error' },
			},
			env: {
				HARPER_EXIT_ON_RESTART: '1',
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				RESTORE_SAFE_MODE_PRELOAD_OUT: preloadOut,
			},
		};
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		await untilOperationsAnswer();
		await untilRouteServed();

		const read = (attributes?: string[]) => ({
			read: true,
			insert: false,
			update: false,
			delete: false,
			attribute_permissions: (attributes ?? []).map((attribute_name) => ({
				attribute_name,
				read: true,
				insert: false,
				update: false,
			})),
		});
		const both = (attributes?: string[]) => ({
			[HELD]: { tables: { SafeModeLedger: read(attributes) } },
			[OTHER]: { tables: { SafeModeOther: read(attributes) } },
		});
		const roles: Record<string, Record<string, unknown>> = {
			nogrant: { super_user: false },
			reader: { super_user: false, ...both(['owner']) },
			auditor: { super_user: false, ...both() },
			// a role whose `operations` list names every managed-backup operation (documented as not grantable by
			// listing) and nothing that is grantable and would change the instance (`restart`, `drop_database`)
			opslist: {
				super_user: false,
				operations: [
					'create_backup',
					'list_backups',
					'verify_backup',
					'delete_backup',
					'purge_backups',
					'restore_backup',
					'get_backup',
					'get_job',
					'search_by_hash',
					'sql',
					'describe_schema',
				],
				...both(),
			},
		};
		for (const [name, permission] of Object.entries(roles)) {
			const role = await op('admin', { operation: 'add_role', role: `${name}_role`, permission });
			strictEqual(role.status, 200, role.text);
			const user = await op('admin', {
				operation: 'add_user',
				role: `${name}_role`,
				username: name,
				password: PASSWORD,
				active: true,
			});
			strictEqual(user.status, 200, user.text);
		}
		for (const [database, tableName, secret, owner] of [
			[HELD, 'SafeModeLedger', MARK_BACKED_UP, HELD_OWNER],
			[OTHER, 'SafeModeOther', MARK_OTHER, OTHER_OWNER],
		]) {
			const seeded = await op('admin', {
				operation: 'upsert',
				database,
				table: tableName,
				records: [{ id: '1', owner, secret }],
			});
			strictEqual(seeded.status, 200, seeded.text);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	function assertNormalBoot(o: Observation, held: string, label: string) {
		strictEqual(o.ops.heldSearch.anonymous.status, 401, `${label}: credential-less operation`);

		const expected: Record<string, string> = {
			heldById: held,
			heldCollection: held,
			graphqlHeld: held,
			otherById: MARK_OTHER,
			graphqlOther: MARK_OTHER,
		};
		for (const [name, mark] of Object.entries(expected)) {
			const by = o.rest[name];
			for (const principal of ['anonymous', 'nogrant', 'reader'] as const)
				deepStrictEqual(by[principal].marks, [], `${label} ${name} ${principal}: ${cell(by[principal])}`);
			for (const principal of ['auditor', 'admin'] as const)
				deepStrictEqual(by[principal].marks, [mark], `${label} ${name} ${principal}: ${cell(by[principal])}`);
		}
		for (const name of ['heldById', 'otherById']) {
			ok([401, 403].includes(o.rest[name].anonymous.status), `${label} ${name} anonymous`);
			strictEqual(o.rest[name].nogrant.status, 403, `${label} ${name} nogrant`);
			strictEqual(o.rest[name].reader.status, 200, `${label} ${name} reader`);
			ok(
				o.rest[name].reader.text.includes(name === 'heldById' ? HELD_OWNER : OTHER_OWNER),
				`${label} ${name} reader reads owner`
			);
		}
		deepStrictEqual(o.rest.heldGuarded.auditor.marks, [held], `${label} guarded auditor`);
		for (const principal of ['anonymous', 'nogrant', 'reader', 'opslist'] as const) {
			ok(
				[401, 403].includes(o.rest.heldGuarded[principal].status),
				`${label} guarded ${principal}: ${o.rest.heldGuarded[principal].status}`
			);
			deepStrictEqual(o.rest.heldGuarded[principal].marks, [], `${label} guarded ${principal}`);
		}
		strictEqual(o.ops.heldDescribe.anonymous.status, 401, `${label} heldDescribe anonymous`);
		strictEqual(o.ops.heldDescribe.nogrant.status, 403, `${label} heldDescribe nogrant`);
		for (const principal of ['reader', 'auditor', 'opslist', 'admin'] as const) {
			const described = o.ops.heldDescribe[principal];
			strictEqual(described.status, 200, `${label} heldDescribe ${principal}: ${described.text.slice(0, 160)}`);
			ok(described.text.includes('SafeModeLedger'), `${label} heldDescribe ${principal} names the table`);
		}
		for (const [search, sql, mark] of [
			['heldSearch', 'heldSql', held],
			['otherSearch', 'otherSql', MARK_OTHER],
		]) {
			strictEqual(o.ops[search].nogrant.status, 403, `${label} ${search} nogrant`);
			strictEqual(o.ops[search].reader.status, 200, `${label} ${search} reader: ${o.ops[search].reader.text}`);
			for (const name of [search, sql]) {
				deepStrictEqual(o.ops[name].nogrant.marks, [], `${label} ${name} nogrant`);
				deepStrictEqual(o.ops[name].reader.marks, [], `${label} ${name} reader`);
				deepStrictEqual(o.ops[name].auditor.marks, [mark], `${label} ${name} auditor`);
				deepStrictEqual(o.ops[name].admin.marks, [mark], `${label} ${name} admin`);
			}
		}
	}

	test('boot 1 (normal): the component serves the value only to permitted principals; a restart restore is scheduled', async () => {
		const backup = await settledJob(startedJob(await op('admin', { operation: 'create_backup', database: HELD })));
		strictEqual(backup.status, 'COMPLETE', `create_backup failed: ${JSON.stringify(backup)}`);
		backupId = backup.result?.backup_id;
		ok(Number.isInteger(backupId), `no backup_id in ${JSON.stringify(backup)}`);

		const changed = await op('admin', {
			operation: 'upsert',
			database: HELD,
			table: 'SafeModeLedger',
			records: [{ id: '1', owner: HELD_OWNER, secret: MARK_LIVE }],
		});
		strictEqual(changed.status, 200, changed.text);

		control = await observe(0);
		controlRoles = await roles();
		console.log('[restore-safe-mode] boot 1 normal', JSON.stringify(summary(control)));
		assertNormalBoot(control, MARK_LIVE, 'boot 1');
		ok(control.bootRows >= 1, `component code ran on at least one thread (SafeModeBoot rows: ${control.bootRows})`);
		for (const form of ['import', 'require'])
			ok(
				control.preloadLines.some((line) => line.startsWith(`${form}:`)),
				`the ${form} preload ran in at least one worker: ${control.preloadLines}`
			);
		strictEqual(control.announcements, 0, 'a normal boot does not announce restore safe mode');

		const manifests = filesUnder(ctx.harper.dataRootDir, (path) =>
			new RegExp(`[\\\\/]manifests[\\\\/]${backupId}\\.json$`).test(path)
		);
		strictEqual(manifests.length, 1, `one manifest for backup ${backupId}: ${manifests}`);
		manifestPath = manifests[0];

		const exited = exitOf(ctx.harper.process);
		restoreJobId = startedJob(
			await op('admin', { operation: 'restore_backup', database: HELD, backup_id: backupId, on_restart: true })
		);
		await exited;
	});

	test('boot 2: with its backup unreadable the restore does not publish, and Harper holds itself in restore safe mode', async (t) => {
		renameSync(manifestPath, manifestPath + '.aside');
		await startHarper(ctx, OPTIONS);
		await untilOperationsAnswer();
		safeMode = await observe(1);
		console.log('[restore-safe-mode] boot 2 restore safe mode', JSON.stringify(summary(safeMode)));
		console.log('[restore-safe-mode] boot 2 preload lines of this boot', safeMode.preloadLines);
		const state = await restoreState(restoreJobId);
		console.log('[restore-safe-mode] boot 2 restore state', JSON.stringify(state));
		const receipt = JSON.parse(readFileSync(Object.keys(state.receipts)[0], 'utf8'));
		console.log('[restore-safe-mode] boot 2 restore record', JSON.stringify(receipt));

		await t.test('the restore is pending after one failed attempt that took its pre-restore backup', () => {
			strictEqual(Object.keys(state.receipts).length, 1, `one restore record on disk: ${JSON.stringify(state)}`);
			strictEqual(receipt.database, HELD);
			strictEqual(receipt.route, 'on_restart');
			strictEqual(receipt.attempts, 1, 'attempts');
			ok(receipt.state !== 'committed' && receipt.state !== 'terminal', `state: ${receipt.state}`);
			ok(typeof receipt.last_error === 'string' && receipt.last_error.length > 0, 'the failed attempt is recorded');
			ok(Number.isInteger(receipt.pre_restore_backup_id), 'the pre-restore backup was taken');
			strictEqual(state.jobStatus, 'IN_PROGRESS', 'a failed attempt that will be retried does not change the job');
		});

		await t.test('hdb.log says why components are off and records the failed attempt', () => {
			strictEqual(safeMode.announcements, 1, `"${RESTORE_SAFE_MODE_LOG}" lines in hdb.log`);
			ok(
				new RegExp(`Attempt 1 of 3 to restore '${HELD}' failed`).test(logText()),
				'hdb.log records the failed attempt'
			);
		});

		await t.test('no component code and no configured preload ran', () => {
			strictEqual(safeMode.bootRows, control.bootRows, 'SafeModeBoot rows added by this boot');
			deepStrictEqual(safeMode.preloadLines, [], 'preload lines (form:pid:threadId:HARPER_SAFE_MODE) of this boot');
		});

		await t.test('no application route answers for anyone, and no value leaves through one', () => {
			const violations: string[] = [];
			for (const [name, by] of Object.entries(safeMode.rest)) {
				for (const principal of PRINCIPALS) {
					const probe = by[principal];
					if (probe.marks.length) violations.push(`${name} ${principal}: served ${cell(probe)}`);
					else if (![401, 403, 404].includes(probe.status))
						violations.push(`${name} ${principal}: ${probe.status} ${probe.text.slice(0, 120)}`);
				}
				if (!name.startsWith('graphql') && by.admin.status !== 404)
					violations.push(`${name} is served to the super user (${by.admin.status})`);
			}
			deepStrictEqual(violations, [], 'application routes answering in restore safe mode');
		});

		await t.test('the database being restored is not readable by anyone: neither generation leaves', () => {
			const violations: string[] = [];
			for (const name of ['heldSearch', 'heldSql', 'heldDescribe']) {
				for (const principal of PRINCIPALS) {
					const probe = safeMode.ops[name][principal];
					if (probe.marks.length) violations.push(`${name} ${principal}: served ${cell(probe)}`);
					if (probe.text.includes(HELD_OWNER)) violations.push(`${name} ${principal}: a row of ${HELD} was returned`);
					// the database is not loaded: a role is refused before the lookup, and the super_user's lookup finds nothing
					const expected = principal === 'anonymous' ? 401 : principal === 'admin' ? 404 : 403;
					if (probe.status !== expected)
						violations.push(`${name} ${principal}: ${probe.status}, expected ${expected}: ${probe.text.slice(0, 160)}`);
				}
			}
			deepStrictEqual(violations, [], 'reads of the database being restored');
		});

		await t.test('the untouched database keeps its role and attribute permissions', async () => {
			deepStrictEqual(await roles(), controlRoles, 'list_roles is what it was in the normal boot');
			for (const name of ['otherSearch', 'otherSql']) {
				for (const principal of PRINCIPALS) {
					strictEqual(
						safeMode.ops[name][principal].status,
						control.ops[name][principal].status,
						`${name} ${principal} status: ${safeMode.ops[name][principal].text}`
					);
					deepStrictEqual(
						JSON.parse(safeMode.ops[name][principal].text),
						JSON.parse(control.ops[name][principal].text),
						`${name} ${principal} body`
					);
				}
			}
		});

		await t.test(
			'every non-super_user request to finish, withdraw or replace the restore, or to read or change its backups, is refused, and nothing changes',
			async () => {
				const requests: Record<string, Record<string, unknown>> = {
					cancel: { operation: 'restore_backup', database: HELD, cancel: true },
					resume: { operation: 'restore_backup', database: HELD, resume: true },
					replace: { operation: 'restore_backup', database: HELD, backup_id: backupId, on_restart: true },
					ordinaryRestore: { operation: 'restore_backup', database: HELD, backup_id: backupId },
					restoreElsewhere: {
						operation: 'restore_backup',
						database: HELD,
						backup_id: backupId,
						target_database: 'restore_safe_mode_copy',
					},
					listBackups: { operation: 'list_backups', database: HELD },
					verifyBackup: { operation: 'verify_backup', database: HELD, backup_id: backupId },
					deleteBackup: { operation: 'delete_backup', database: HELD, backup_id: backupId },
					purgeBackups: { operation: 'purge_backups', database: HELD, keep_count: 0 },
					createBackup: { operation: 'create_backup', database: HELD },
					getBackup: { operation: 'get_backup', database: HELD },
					dropDatabase: { operation: 'drop_database', database: HELD },
					restart: { operation: 'restart' },
				};
				const beforeState = await restoreState(restoreJobId);
				const cells: Record<string, Record<string, string>> = {};
				const violations: string[] = [];
				for (const [name, body] of Object.entries(requests)) {
					cells[name] = {};
					for (const principal of NON_SUPER) {
						if (!running()) {
							violations.push(`${name} ${principal}: not sent, Harper exited after an earlier request`);
							continue;
						}
						const r = await op(principal, body).catch((error): Probe => ({
							status: 0,
							text: `request failed: ${error?.cause?.code ?? error}`,
							marks: [],
						}));
						cells[name][principal] = `${r.status}`;
						const expected = principal === 'anonymous' ? 401 : 403;
						if (r.status !== expected) violations.push(`${name} ${principal}: ${r.status} ${r.text.slice(0, 200)}`);
						if (r.marks.length) violations.push(`${name} ${principal}: body carries ${r.marks}`);
						if (/Starting job with id/.test(r.text)) violations.push(`${name} ${principal}: a job was started`);
					}
				}
				// get_job is documented as open to every authenticated user, so the restore's job record is readable;
				// it must carry no stored value
				cells.getJob = {};
				for (const principal of running() ? NON_SUPER : []) {
					const r = await op(principal, { operation: 'get_job', id: restoreJobId });
					cells.getJob[principal] = `${r.status}`;
					const expected = principal === 'anonymous' ? 401 : 200;
					if (r.status !== expected) violations.push(`getJob ${principal}: ${r.status} ${r.text.slice(0, 200)}`);
					if (r.marks.length || r.text.includes(HELD_OWNER))
						violations.push(`getJob ${principal}: the job record carries a stored value`);
				}
				console.log('[restore-safe-mode] boot 2 restore-control cells', JSON.stringify(cells));
				// a refused restart must not fire late either
				const exitedLate = await Promise.race([
					new Promise<boolean>((resolveExit) => ctx.harper.process.once('exit', () => resolveExit(true))),
					sleep(3_000).then(() => false),
				]);
				ok(!exitedLate, 'Harper exited after a refused request');
				deepStrictEqual(violations, [], 'non-super_user requests answered other than documented');
				const afterState = await restoreState(restoreJobId);
				deepStrictEqual(afterState, beforeState, 'the restore record, backups, pins, job and process are untouched');
				strictEqual((await op('admin', { operation: 'user_info' })).status, 200, 'Harper is still answering');
			}
		);

		await t.test('the super_user sees the documented refusals for the database being restored', async () => {
			for (const operation of ['create_backup', 'get_backup', 'drop_database']) {
				const r = await op('admin', { operation, database: HELD });
				strictEqual(r.status, 409, `${operation} on the database being restored: ${r.status} ${r.text.slice(0, 200)}`);
				ok(/restor/i.test(r.text), `${operation} names the restore: ${r.text.slice(0, 200)}`);
			}
		});
	});

	test('boot 3 (control): the super_user resumes the restore; it publishes and the component and its restrictions are back', async () => {
		renameSync(manifestPath + '.aside', manifestPath);
		const exited = exitOf(ctx.harper.process);
		const resumed = await op('admin', { operation: 'restore_backup', database: HELD, resume: true });
		const resumeJobId = startedJob(resumed);
		await exited;
		await startHarper(ctx, OPTIONS);
		await untilOperationsAnswer();

		const restored = await settledJob(resumeJobId);
		strictEqual(restored.status, 'COMPLETE', `the resumed restore failed: ${JSON.stringify(restored)}`);
		strictEqual(restored.result?.backup_id, backupId);
		if (resumeJobId !== restoreJobId)
			strictEqual((await settledJob(restoreJobId)).status, 'ERROR', 'the job the resume replaced ends in ERROR');
		await untilRouteServed();

		const o = await observe(safeMode.announcements);
		console.log('[restore-safe-mode] boot 3 after the restore published', JSON.stringify(summary(o)));
		assertNormalBoot(o, MARK_BACKED_UP, 'boot 3');
		ok(o.bootRows > safeMode.bootRows, `component code ran again (${safeMode.bootRows} -> ${o.bootRows})`);
		for (const form of ['import', 'require'])
			ok(
				o.preloadLines.some((line) => line.startsWith(`${form}:`)),
				`the ${form} preload ran again`
			);
		strictEqual(o.announcements, safeMode.announcements, 'no new restore safe mode announcement');
		deepStrictEqual(
			filesUnder(ctx.harper.dataRootDir, (path) => path.endsWith('.intent')),
			[],
			'the restore record is gone once the restore published'
		);
	});
});
