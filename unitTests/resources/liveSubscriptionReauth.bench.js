/**
 * Benchmark: continuous re-authorization of live subscriptions at scale (server/liveSubscriptionAuth.ts).
 *
 * Registers SUBSCRIPTIONS subscriptions across USERS users (ROLES roles) through the real
 * Resource.ts subscribe path, so every recheck is the production closure: findAndValidateUser plus the
 * table's default allowRead. Reports, per scenario, wall and CPU time and the longest event-loop stall:
 * - a backstop sweep of every subscription
 * - the work one hdb_user write triggers (its notification and the recheck pass it schedules)
 * - the work one hdb_role write triggers
 *
 * Uses only APIs that predate the scaling change (`_sweepNow`, `onUserChange`), so the same file runs
 * against an older build for a before/after comparison.
 *
 * Run via: npm run bench, or `npx mocha unitTests/resources/liveSubscriptionReauth.bench.js`.
 */
// a backstop tick landing mid-measurement would skew it; this keeps the timer out of the way
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS = String(24 * 60 * 60 * 1000);
const testUtils = require('../testUtils');
const assert = require('node:assert');
const { table, databases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const userModule = require('#src/security/user');
const { _sweepNow, _liveSubscriptionCount } = require('#src/server/liveSubscriptionAuth');

const USERS = Number(process.env.REAUTH_BENCH_USERS) || 5_000;
const SUBSCRIPTIONS_PER_USER = Number(process.env.REAUTH_BENCH_SUBS_PER_USER) || 20;
const ROLES = 50;
const ROUNDS = 3;
const TABLE_NAME = 'ReauthBench';

const roleId = (index) => `reauth_bench_role_${index}`;
const username = (index) => `reauth_bench_user_${index}`;

function benchRole(index) {
	return {
		id: roleId(index),
		role: roleId(index),
		permission: {
			super_user: false,
			test: {
				tables: {
					[TABLE_NAME]: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
				},
			},
		},
	};
}

function fakeSubscription() {
	return { closed: false, end() {}, on() {} };
}

let resolutions = 0;
const findAndValidateUser = userModule.findAndValidateUser;
userModule.findAndValidateUser = function (...args) {
	resolutions++;
	return findAndValidateUser.apply(this, args);
};

let userChanges = 0;
userModule.onUserChange(() => userChanges++);

// every recheck of a non-scoped principal assigns its context's user, before and after this change alike
let rechecks = 0;
function countingContext(user) {
	let current = user;
	return {
		authorize: true,
		get user() {
			return current;
		},
		set user(value) {
			rechecks++;
			current = value;
		},
	};
}

const turn = () => new Promise(setImmediate);

/** Runs `work`, then waits until no recheck has run for `quietTurns` event-loop turns (a sliced pass rechecks every turn). */
async function measure(work, { quietTurns = 5 } = {}) {
	let maxStall = 0;
	let probing = true;
	let lastTurn = performance.now();
	const probe = () => {
		const now = performance.now();
		maxStall = Math.max(maxStall, now - lastTurn);
		lastTurn = now;
		if (probing) setImmediate(probe);
	};
	setImmediate(probe);
	const resolutionsBefore = resolutions;
	const rechecksBefore = rechecks;
	const cpuBefore = process.cpuUsage();
	const start = performance.now();
	await work();
	let quiet = 0;
	let last = rechecks;
	while (quiet < quietTurns) {
		await turn();
		if (rechecks === last) quiet++;
		else quiet = 0;
		last = rechecks;
	}
	const wall = performance.now() - start;
	const cpu = process.cpuUsage(cpuBefore);
	probing = false;
	return {
		wall,
		cpu: (cpu.user + cpu.system) / 1000,
		maxStall,
		resolutions: resolutions - resolutionsBefore,
		rechecks: rechecks - rechecksBefore,
	};
}

function report(label, samples) {
	const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
	console.log(
		`  ${label.padEnd(28)} wall ${median('wall').toFixed(1).padStart(8)} ms   cpu ${median('cpu').toFixed(1).padStart(8)} ms   ` +
			`max loop stall ${median('maxStall').toFixed(1).padStart(7)} ms   rechecks ${String(median('rechecks')).padStart(6)}   user resolutions ${String(median('resolutions')).padStart(6)}`
	);
}

describe('Benchmark: live subscription re-authorization at scale', function () {
	this.timeout(1_800_000);
	let Bench;

	before(async function () {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		setMainIsWorker(true);
		await testUtils.ensureSystemTables();
		const Table = table({
			table: TABLE_NAME,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Bench = class extends Table {
			subscribe() {
				return fakeSubscription();
			}
		};
		const users = [];
		for (let index = 0; index < USERS; index++) {
			users.push({ username: username(index), active: true, role: benchRole(index % ROLES) });
		}
		await testUtils.seedUsers(users);

		const registrationStart = performance.now();
		for (let index = 0; index < USERS; index++) {
			const user = await userModule.findAndValidateUser(username(index), undefined, false);
			for (let n = 0; n < SUBSCRIPTIONS_PER_USER; n++) {
				await Bench.subscribe(`topic-${n}`, undefined, countingContext(user));
			}
		}
		const registered = _liveSubscriptionCount();
		assert.strictEqual(registered, USERS * SUBSCRIPTIONS_PER_USER);
		console.log(
			`\n  ${registered} subscriptions across ${USERS} users and ${ROLES} roles registered in ${(performance.now() - registrationStart).toFixed(0)} ms`
		);
	});

	after(() => testUtils.seedUsers());

	it('backstop sweep of every subscription', async () => {
		const samples = [];
		for (let round = 0; round < ROUNDS; round++) samples.push(await measure(() => _sweepNow(), { quietTurns: 1 }));
		report('full sweep', samples);
		assert.strictEqual(_liveSubscriptionCount(), USERS * SUBSCRIPTIONS_PER_USER, 'a sweep revoked a subscription');
	});

	it('one hdb_user write', async () => {
		const samples = [];
		for (let round = 0; round < ROUNDS; round++) {
			const index = (round * 7) % USERS;
			const before = userChanges;
			samples.push(
				await measure(async () => {
					await databases.system.hdb_user.put({ username: username(index), active: true, role: roleId(index % ROLES) });
					while (userChanges === before) await turn();
				})
			);
		}
		report('hdb_user change', samples);
		assert.strictEqual(
			_liveSubscriptionCount(),
			USERS * SUBSCRIPTIONS_PER_USER,
			'a user change revoked a subscription'
		);
	});

	it('one hdb_role write', async () => {
		const samples = [];
		for (let round = 0; round < ROUNDS; round++) {
			const before = userChanges;
			samples.push(
				await measure(async () => {
					await databases.system.hdb_role.put(benchRole(round % Math.min(ROLES, USERS)));
					while (userChanges === before) await turn();
				})
			);
		}
		report('hdb_role change', samples);
		assert.strictEqual(
			_liveSubscriptionCount(),
			USERS * SUBSCRIPTIONS_PER_USER,
			'a role change revoked a subscription'
		);
	});
});
