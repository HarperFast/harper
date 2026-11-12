const assert = require('node:assert');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PID_DIR_PATH } = require('../perPidRoot');

// A restart whose wall clock is behind the bounds the database persisted, simulated by persisting them
// ahead of the clock. Each step is its own process, as a restart is: a raised clock is process-wide and
// cannot be lowered, so none of this can run in the shared test process.
const LEAD_MS = 60_000;
const TEN_YEARS_MS = 10 * 365.25 * 86_400_000;

describe('a restart behind the persisted origin floor (harper#2629)', function () {
	this.timeout(120_000);
	let dir;
	const children = [];

	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
	});
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(PID_DIR_PATH, 'origin-floor-restart-'));
	});
	afterEach(async () => {
		for (const { child, exited } of children.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await exited;
		}
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	function run(options) {
		const child = fork(path.join(__dirname, 'fixtures/originFloorRestart.cjs'), [JSON.stringify({ dir, ...options })], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		});
		const exited = new Promise((resolve) => child.once('exit', resolve));
		children.push({ child, exited });
		let stderr = '';
		child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
		const reply = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${options.mode} child timed out: ${stderr}`)), 60_000);
			child.on('message', (message) => {
				clearTimeout(timer);
				if (message.type === 'error') reject(new Error(message.message));
				else resolve(message.result);
			});
			child.once('exit', (code, signal) => {
				clearTimeout(timer);
				reject(new Error(`${options.mode} child exited ${code}/${signal}: ${stderr}`));
			});
		});
		// the next process opens the same database, so a finished one must have released it
		const done = options.hold ? reply : reply.then(async (result) => (await exited, result));
		return { child, reply: done, exited };
	}

	async function restartAfter(seedOptions) {
		const seeded = await run({ mode: 'seed', database: 'restartFloor', ...seedOptions }).reply;
		const restarted = await run({ mode: 'restart', database: 'restartFloor' }).reply;
		assert.ok(restarted.wall < restarted.bound, 'the restart must happen while the clock is behind the bound');
		return { seeded, restarted };
	}

	function assertAbove(restarted, bound) {
		assert.ok(restarted.putKey > bound, `a write's local key ${restarted.putKey} is above ${bound}`);
		assert.strictEqual(restarted.resumedKey, restarted.putKey, 'a read resuming at the bound returns the write');
		assert.ok(restarted.rawTimestamp > bound, 'an unreserved native handle starts above the bound');
		assert.deepStrictEqual(restarted.rawLogKeys, [restarted.rawTimestamp], 'its local entry is keyed above the bound');
		assert.ok(restarted.worker.firstMint > bound, "a worker's first timestamp is above the bound");
		assert.ok(restarted.worker.putKey > bound, "a worker's first write is above the bound");
	}

	it('a persisted write fence is restored at open, before any write, and clears when cancelled', async () => {
		const { target } = await run({ mode: 'fenceSeed', database: 'restartFence' }).reply;
		const restarted = await run({ mode: 'fenceRestart', database: 'restartFence' }).reply;
		assert.strictEqual(restarted.fenced, true);
		assert.deepStrictEqual(restarted.record, { epoch: 'e1', target, state: 'fenced' });
		assert.strictEqual(restarted.refusal?.statusCode, 503);
		assert.match(restarted.refusal.message, /being removed from its cluster/);
		assert.strictEqual(restarted.cleared, null);
	});

	it('keys every later local entry above a persisted origin-closed floor', async () => {
		const { seeded, restarted } = await restartAfter({ floorLead: LEAD_MS });
		assert.ok(seeded.floor > seeded.ceiling);
		assertAbove(restarted, seeded.floor);
	});

	it('keys every later local entry above a persisted issuance ceiling', async () => {
		const { seeded, restarted } = await restartAfter({ ceilingLead: LEAD_MS });
		assert.ok(seeded.ceiling > seeded.floor);
		assertAbove(restarted, seeded.ceiling);
	});

	it('refuses to open a database whose persisted floor the clock cannot be raised to, on every attempt', async () => {
		await run({ mode: 'seed', database: 'restartFloor', floorLead: TEN_YEARS_MS + 86_400_000 }).reply;
		const { errors } = await run({ mode: 'refusedOpen', database: 'restartFloor' }).reply;
		assert.strictEqual(errors.length, 2);
		for (const message of errors)
			assert.match(message ?? 'opened', /persisted transaction-log bounds cannot be restored/);
	});

	it("covers another database's key minted ahead of the wall clock, so it alone restarts above it", async () => {
		const crossing = run({ mode: 'crossDatabase', lead: LEAD_MS, hold: true });
		const before = await crossing.reply;
		assert.ok(before.key > before.claimed, "the other database's claim lifted this database's key");
		assert.ok(before.ceiling >= before.key, "this database's own ceiling covers its key");
		crossing.child.kill('SIGKILL');
		await crossing.exited;
		const after = await run({ mode: 'reopenB' }).reply;
		assert.ok(after.wall < before.key, 'the reopen must happen while the clock is behind the earlier key');
		assert.ok(after.key > before.key, 'the reopened database does not reissue the earlier key');
	});
});
