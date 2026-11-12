/**
 * Unit tests for remote-target mode: argument and hosts-file handling, the probe merge rules, the RPC
 * channel and the agent's lifecycle helpers, the orchestration of a target split across hosts, and the
 * GCP scripts' cost guards. Run with:
 *   node --test benchmarks/ycsb-vs-pg/
 */
import { test } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
	agentCommand,
	checkPlacement,
	parseHostsFile,
	parsePlacedTargets,
	placedName,
	rolesFor,
	withRemoteTarget,
	type HostsFile,
	type PartDescriptor,
} from './remote.mts';
import { parseCells } from './memory-sweep.mts';
import { targetHostCpus, type CpuTopology } from './resources.mts';
import { counterEvents, parsePerfStat } from './perfProfile.mts';
import {
	alignedPeakTotal,
	compositeProbe,
	localProbe,
	mergeHostLoads,
	mergeReadings,
	type TargetProbe,
} from './probe.mts';
import { RpcClient, decode, encode, parseLine, FRAME_MARKER } from './rpc.mts';
import { park, serialQueue } from './targetAgent.mts';
import { pingPong, rttStats, startEchoServer } from './rtt.mts';
import { defaultThreads, type Running, type Session } from './run-compare.mts';

const execAsync = promisify(execFile);
const DIR = import.meta.dirname;

test('targets take an optional topology; b only for stack targets, only with --hosts', () => {
	deepStrictEqual(parsePlacedTargets('harper-uws, pg-redis, pg-redis@b', { remote: true }), [
		{ name: 'harper-uws', target: 'harper-uws', topology: 'a' },
		{ name: 'pg-redis', target: 'pg-redis', topology: 'a' },
		{ name: 'pg-redis@b', target: 'pg-redis', topology: 'b' },
	]);
	deepStrictEqual(parsePlacedTargets('pg-only@a', { remote: false }), [
		{ name: 'pg-only', target: 'pg-only', topology: 'a' },
	]);
	throws(() => parsePlacedTargets('pg-redis@b', { remote: false }), /needs --hosts/);
	throws(() => parsePlacedTargets('harper-uws@b', { remote: true }), /one process/);
	throws(() => parsePlacedTargets('pg-redis@c', { remote: true }), /a or b/);
	throws(() => parsePlacedTargets('pg-redis,pg-redis@a', { remote: true }), /listed twice/);
	throws(() => parsePlacedTargets('redis@b', { remote: true }), /unknown target/);
	strictEqual(placedName({ target: 'pg-redis', topology: 'b' }), 'pg-redis@b');
	strictEqual(placedName({ target: 'pg-redis' }), 'pg-redis');
	deepStrictEqual(rolesFor({ name: 'pg-redis@b', target: 'pg-redis', topology: 'b' }), ['stack', 'redis', 'postgres']);
	deepStrictEqual(rolesFor({ name: 'pg-only@b', target: 'pg-only', topology: 'b' }), ['stack', 'postgres']);
	deepStrictEqual(rolesFor({ name: 'pg-redis', target: 'pg-redis', topology: 'a' }), ['stack']);
	deepStrictEqual(rolesFor({ name: 'harper', target: 'harper', topology: 'a' }), ['harper']);
});

test('sweep cells carry the topology b suffix in remote mode', () => {
	deepStrictEqual(parseCells('2:C:pg-redis@b, 2:C:pg-redis', { remote: true }), [
		{ ratio: 2, workload: 'C', target: 'pg-redis', topology: 'b' },
		{ ratio: 2, workload: 'C', target: 'pg-redis' },
	]);
	throws(() => parseCells('2:C:pg-redis@b'), /needs --hosts/);
});

const GCP_HOSTS: HostsFile = {
	repoDir: '/opt/ycsb/harper',
	sshOptions: ['-i', '/home/ycsb/.ssh/ycsb_run'],
	roles: {
		harper: { ssh: 'ycsb@10.77.0.3', address: '10.77.0.3' },
		stack: { ssh: 'ycsb@10.77.0.4', address: '10.77.0.4' },
		redis: { ssh: 'ycsb@10.77.0.5', address: '10.77.0.5' },
		postgres: { ssh: 'ycsb@10.77.0.6', address: '10.77.0.6' },
	},
};

test('a hosts file names each role once, by ssh or by command', () => {
	deepStrictEqual(parseHostsFile(JSON.stringify(GCP_HOSTS)), GCP_HOSTS);
	throws(() => parseHostsFile('{}'), /"roles"/);
	throws(() => parseHostsFile(JSON.stringify({ roles: { cache: { ssh: 'x' } } })), /unknown role "cache"/);
	throws(() => parseHostsFile(JSON.stringify({ roles: { harper: {} } })), /exactly one of ssh, command/);
	throws(
		() => parseHostsFile(JSON.stringify({ roles: { harper: { ssh: 'h', command: ['node'] } } })),
		/exactly one of ssh, command/
	);
	throws(() => parseHostsFile(JSON.stringify({ roles: { harper: { ssh: 'h' } } })), /needs a repoDir/);
	throws(() => parseHostsFile(JSON.stringify({ roles: { harper: { command: [] } } })), /non-empty array/);
	throws(
		() => parseHostsFile(JSON.stringify({ repoDir: '/r', roles: { harper: { ssh: 'h', serverCpus: '3-1' } } })),
		/bad CPU list/
	);
});

test('a placement must have its hosts, separate hosts for b, and token auth off loopback', () => {
	const placed = (list: string) => parsePlacedTargets(list, { remote: true });
	checkPlacement(GCP_HOSTS, placed('harper-uws,pg-redis,pg-redis@b'), 'token');
	const noRedis: HostsFile = { ...GCP_HOSTS, roles: { ...GCP_HOSTS.roles, redis: undefined } };
	throws(() => checkPlacement(noRedis, placed('pg-redis@b'), 'token'), /needs a "redis" host/);
	checkPlacement(noRedis, placed('pg-only@b'), 'token');
	const shared: HostsFile = { ...GCP_HOSTS, roles: { ...GCP_HOSTS.roles, redis: GCP_HOSTS.roles.postgres } };
	throws(() => checkPlacement(shared, placed('pg-redis@b'), 'token'), /separate hosts/);
	const loopback: HostsFile = {
		repoDir: '/r',
		roles: { stack: { ssh: 'localhost' }, redis: { ssh: 'r' }, postgres: { ssh: 'p' } },
	};
	throws(() => checkPlacement(loopback, placed('pg-redis@b'), 'token'), /address the other hosts reach/);
	throws(() => checkPlacement(GCP_HOSTS, placed('harper-uws'), 'none'), /--auth=token/);
	// The local validation: both "hosts" on one machine, Harper on its pool loopback address.
	checkPlacement({ repoDir: '/r', roles: { harper: { ssh: 'localhost' } } }, placed('harper-uws'), 'none');
	checkPlacement(GCP_HOSTS, placed('pg-redis'), 'none');
});

test('an agent is started over ssh in the checkout, or by its own command', () => {
	deepStrictEqual(agentCommand(GCP_HOSTS.roles.harper!, GCP_HOSTS), [
		'ssh',
		'-o',
		'BatchMode=yes',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=4',
		'-i',
		'/home/ycsb/.ssh/ycsb_run',
		'ycsb@10.77.0.3',
		'--',
		"cd '/opt/ycsb/harper' && exec node benchmarks/ycsb-vs-pg/targetAgent.mts",
	]);
	deepStrictEqual(
		agentCommand({ ssh: 'h', repoDir: "/it's" }, { roles: {} }).at(-1),
		`cd '/it'\\''s' && exec node benchmarks/ycsb-vs-pg/targetAgent.mts`
	);
	deepStrictEqual(agentCommand({ command: ['node', 'agent.mts'] }, GCP_HOSTS), ['node', 'agent.mts']);
});

test("a target host's cpus: all of a k-core host, else the fastest cores with the rest for the agent", () => {
	const vm4: CpuTopology[] = [0, 1, 2, 3].map((cpu) => ({ cpu, siblings: [cpu], maxKHz: 0 }));
	deepStrictEqual(targetHostCpus(vm4, 4), { server: [0, 1, 2, 3], rest: [] });
	const smt4: CpuTopology[] = Array.from({ length: 8 }, (_, cpu) => ({
		cpu,
		siblings: [cpu % 4, (cpu % 4) + 4],
		maxKHz: 0,
	}));
	deepStrictEqual(targetHostCpus(smt4, 4), { server: [0, 1, 2, 3], rest: [] });
	const vm8: CpuTopology[] = Array.from({ length: 8 }, (_, cpu) => ({ cpu, siblings: [cpu], maxKHz: 0 }));
	deepStrictEqual(targetHostCpus(vm8, 4), { server: [0, 1, 2, 3], rest: [4, 5, 6, 7] });
	throws(() => targetHostCpus(vm4, 6), /need 6 physical cores/);
});

test('perf counters use the hybrid PMU where there is one and cpu elsewhere, and parse either', () => {
	strictEqual(counterEvents('cpu').instructionsUser, 'cpu/instructions/u');
	strictEqual(counterEvents('cpu_core').cyclesKernel, 'cpu_core/cycles/k');
	const cg = 'user.slice/x.scope';
	const lines = Object.values(counterEvents('cpu')).map((event, i) => `${i + 1},,${event},${cg},1000,100.00,,`);
	deepStrictEqual(parsePerfStat(lines.join('\n')), {
		[cg]: {
			instructionsUser: 1,
			instructionsKernel: 2,
			cyclesUser: 3,
			cyclesKernel: 4,
			contextSwitches: 5,
			cpuMigrations: 6,
			pageFaults: 7,
		},
	});
});

test('memory peaks across hosts are summed only where the readings coincide', () => {
	// Host A peaks at 3 GiB while B is at 1, then they swap: no instant ever held 6 GiB.
	const a: [number, number][] = [
		[1000, 3],
		[3000, 1],
	];
	const b: [number, number][] = [
		[1100, 1],
		[3100, 3],
	];
	strictEqual(alignedPeakTotal([a, b]), 4);
	strictEqual(alignedPeakTotal([a]), 3);
	strictEqual(alignedPeakTotal([]), 0);
	// Before a host's first reading, its first one stands in (the sampler starts with the window).
	strictEqual(alignedPeakTotal([[[0, 5]], [[10, 2]]]), 7);
});

test('per-host loads merge to the busiest host, and readings merge by component', () => {
	deepStrictEqual(
		mergeHostLoads({
			stack: { loadavg1: 1, otherCores: 0.1, ownCores: 3, agentCores: 0.01 },
			redis: { loadavg1: 2, otherCores: 0.4, ownCores: 1, agentCores: 0.02 },
		}),
		{ loadavg1: 2, otherCores: 0.4, ownCores: 4, agentCores: 0.03 }
	);
	const reading = (component: string, cpu: number, at: number, bytes: number) => ({
		before: { cpuSeconds: { [component]: 0 }, memoryBytes: { [component]: 0 } },
		after: { cpuSeconds: { [component]: cpu }, memoryBytes: { [component]: bytes } },
		meanClockGHz: 0,
		memory: {
			peakBytes: { [component]: bytes },
			meanBytes: { [component]: bytes },
			peakTotalBytes: bytes,
			timeline: [[at, bytes]] as [number, number][],
		},
		host: { loadavg1: 0, otherCores: 0, ownCores: 1 },
		cgroupMemory: {},
	});
	const merged = mergeReadings({ stack: reading('fastify', 2, 1000, 5), postgres: reading('postgres', 3, 1001, 7) });
	deepStrictEqual(merged.after.cpuSeconds, { fastify: 2, postgres: 3 });
	deepStrictEqual(merged.memory!.peakBytes, { fastify: 5, postgres: 7 });
	strictEqual(merged.memory!.peakTotalBytes, 12);
	deepStrictEqual(Object.keys(merged.hosts!), ['stack', 'postgres']);
});

function fakeProbe(name: string, log: string[], { failBegin = false } = {}): TargetProbe {
	return {
		components: [name],
		hasRedis: name === 'redis',
		verifyPlacement: async () => 1,
		sample: async () => ({ cpuSeconds: { [name]: 1 }, memoryBytes: { [name]: 1 } }),
		cpuSeconds: async () => 1,
		cgroupMemory: async () => ({}),
		async beginWindow() {
			log.push(`${name} begin`);
			if (failBegin) throw new Error(`${name} could not start perf`);
		},
		async endWindow() {
			log.push(`${name} end`);
			return mergeReadings({});
		},
		fold: async () => ({ [name]: 1 }),
	};
}

test('a window that cannot open on one host is closed on the hosts where it did', async () => {
	const log: string[] = [];
	const probe = compositeProbe({
		stack: fakeProbe('fastify', log),
		postgres: fakeProbe('postgres', log, { failBegin: true }),
	});
	await rejects(probe.beginWindow({ counters: true }), /postgres could not start perf/);
	deepStrictEqual(log.sort(), ['fastify begin', 'fastify end', 'postgres begin']);
	strictEqual(await probe.verifyPlacement(), 2);
	deepStrictEqual(await probe.fold('x'), { fastify: 1, postgres: 1 });
});

test('RPC frames carry non-finite numbers and stand apart from log text', () => {
	deepStrictEqual(decode(encode({ max: Infinity, min: -Infinity, n: 1 })), { max: Infinity, min: -Infinity, n: 1 });
	deepStrictEqual(parseLine('plain log line'), { log: 'plain log line' });
	const frame = `${FRAME_MARKER}${encode({ id: 3, ok: true, result: 1 })}`;
	deepStrictEqual(parseLine(`partial log${frame}`), { log: 'partial log', response: { id: 3, ok: true, result: 1 } });
	throws(() => parseLine(`${FRAME_MARKER}{"id":"x"}`), /malformed RPC frame/);
});

/** An agent stand-in: real serveRpc in a child process, with methods that misbehave on purpose. */
const FAKE_AGENT = `
import { serveRpc } from ${JSON.stringify(join(DIR, 'rpc.mts'))};
const write = process.stdout.write.bind(process.stdout);
serveRpc({
	echo: (params) => params,
	fail: () => { throw new Error('refused on purpose'); },
	noisy: () => { write('a log line on stdout\\n'); write('no newline'); return 'after noise'; },
	big: ({ bytes }) => 'x'.repeat(bytes),
	hang: () => new Promise(() => {}),
	exit: () => process.exit(7),
}, { input: process.stdin, write, onEnd: () => process.exit(0) });
`;

test('the RPC client correlates replies, keeps log lines out, and fails closed on a stuck or dead agent', async () => {
	const logs: string[] = [];
	const client = new RpcClient('fake', [process.execPath, '--input-type=module', '-e', FAKE_AGENT], {
		onLog: (line) => logs.push(line),
	});
	try {
		deepStrictEqual(await client.call('echo', { a: [1, 2], max: Infinity }, 10_000), { a: [1, 2], max: Infinity });
		await rejects(client.call('fail', {}, 10_000), /refused on purpose/);
		await rejects(client.call('missing', {}, 10_000), /unknown method missing/);
		strictEqual(await client.call('noisy', {}, 10_000), 'after noise');
		ok(logs.includes('a log line on stdout'));
		ok(logs.includes('no newline'), 'text before a frame on the same line is a log line');
		strictEqual(((await client.call('big', { bytes: 3_000_000 }, 30_000)) as string).length, 3_000_000);
		const [first, second] = await Promise.all([
			client.call('echo', 'first', 10_000),
			client.call('echo', 'second', 10_000),
		]);
		deepStrictEqual([first, second], ['first', 'second']);
		await rejects(client.call('hang', {}, 200), /did not answer within 200 ms/);
		await rejects(
			client.call('echo', 'after a timeout', 10_000),
			/did not answer/,
			'a timed-out agent is not used again'
		);
	} finally {
		await client.close(5_000);
	}
	const dying = new RpcClient('dying', [process.execPath, '--input-type=module', '-e', FAKE_AGENT], {
		onLog: () => {},
	});
	await rejects(dying.call('exit', {}, 10_000), /exited \(7\)/);
	await rejects(dying.call('echo', 1, 10_000), /exited \(7\)/);
});

test('the target agent answers over stdio and measures round trips on this host', async () => {
	const agent = new RpcClient('agent', [process.execPath, join(DIR, 'targetAgent.mts')], { onLog: () => {} });
	try {
		deepStrictEqual(Object.keys(await agent.call('ping', {}, 30_000)), ['pid']);
		await rejects(agent.call('startTarget', { target: 'harper' }, 30_000), /not initialized/);
		const { port } = await agent.call<{ port: number }>('rttServer', {}, 30_000);
		const stats = await agent.call<{ count: number; p50Us: number }>('rttProbe', { host: '127.0.0.1', port }, 60_000);
		strictEqual(stats.count, 2000);
		ok(stats.p50Us > 0);
	} finally {
		await agent.close(30_000);
	}
	strictEqual(await agent.exited, 0, 'a closed channel ends the agent cleanly');
});

test('a parked target runs its own teardown on stop, and a failed launch rejects the start', async () => {
	const log: string[] = [];
	const parked = await park<string>(async (body) => {
		log.push('setup');
		try {
			await body('running');
		} finally {
			log.push('teardown');
		}
	});
	strictEqual(parked.running, 'running');
	deepStrictEqual(log, ['setup']);
	await Promise.all([parked.stop(), parked.stop()]);
	deepStrictEqual(log, ['setup', 'teardown']);
	await rejects(
		park(async () => {
			throw new Error('compose up failed');
		}),
		/compose up failed/
	);
	await rejects(
		park(async () => {}),
		/stopped before it was ready/
	);
});

test('lifecycle changes run one at a time, in order, past a failure', async () => {
	const serial = serialQueue();
	const log: string[] = [];
	const step = (name: string, ms: number, fail = false) =>
		serial(async () => {
			log.push(`${name} start`);
			await new Promise((r) => setTimeout(r, ms));
			log.push(`${name} end`);
			if (fail) throw new Error(name);
		});
	const results = await Promise.allSettled([step('a', 30, true), step('b', 1), step('c', 1)]);
	deepStrictEqual(log, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
	deepStrictEqual(
		results.map((r) => r.status),
		['rejected', 'fulfilled', 'fulfilled']
	);
});

test('round-trip statistics are order statistics of the samples', async () => {
	deepStrictEqual(rttStats([5, 1, 3, 2, 4]), { count: 5, p50Us: 3, p99Us: 5, meanUs: 3, minUs: 1, maxUs: 5 });
	throws(() => rttStats([]), /no round trips/);
	const echo = await startEchoServer('127.0.0.1');
	try {
		const stats = await pingPong('127.0.0.1', echo.port, { count: 50, warmup: 5 });
		strictEqual(stats.count, 50);
		ok(stats.minUs <= stats.p50Us && stats.p50Us <= stats.p99Us && stats.p99Us <= stats.maxUs);
	} finally {
		await echo.close();
	}
});

/** Agents that record their calls; `failStart` makes one role's start fail. */
function fakeRemote(baseUrl: string, failStart?: string) {
	const calls: string[] = [];
	let handles = 0;
	const agent = (role: string) => ({
		name: role,
		async call(method: string, params: any) {
			calls.push(`${role} ${method}${params?.handle ? ` ${params.handle}` : ''}`);
			if (method === 'startTarget') {
				if (role === failStart) throw new Error(`${role} did not start`);
				const services: string[] = params.launch.stack?.services ?? [];
				const descriptor: PartDescriptor = {
					baseUrl: services.includes('fastify') ? baseUrl : '',
					startupMs: 10,
					memoryLimits: Object.fromEntries(
						services.map((s) => [s, { memoryMaxBytes: 1, swapMaxBytes: 0, ancestorMaxBytes: Infinity }])
					),
					components: services,
					hasRedis: services.includes('redis'),
					hasPostgres: services.includes('postgres'),
					hasRocksdb: false,
				};
				return { handle: ++handles, descriptor, launch: params.launch };
			}
			if (method === 'snapshot') return null;
			return undefined;
		},
	});
	const agents = { stack: agent('stack'), redis: agent('redis'), postgres: agent('postgres') };
	const session = {
		options: { config: { table: 'usertable' } },
		remote: {
			redisPassword: 'pw',
			agentFor: (role: keyof typeof agents) => agents[role],
			address: (role: string) => `10.0.0.${role.length}`,
		},
	} as unknown as Session;
	return { session, calls };
}

test('topology b starts the backends before Fastify, routes Postgres work to its host, and stops front first', async () => {
	const server = createServer((req, res) => res.writeHead(200).end('[]'));
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		const { session, calls } = fakeRemote(baseUrl);
		let seen: Running | undefined;
		await withRemoteTarget(
			session,
			'pg-redis',
			async (running) => {
				seen = running;
				await running.afterLoad!();
				await running.snapshot('pg-17');
			},
			{ topology: 'b', restore: 'pg-17' }
		);
		strictEqual(seen!.baseUrl, baseUrl);
		deepStrictEqual(seen!.probe.components.sort(), ['fastify', 'postgres', 'redis']);
		strictEqual(seen!.probe.hasRedis, true);
		deepStrictEqual(Object.keys(seen!.memoryLimits).sort(), ['fastify', 'postgres', 'redis']);
		const starts = calls.filter((c) => c.endsWith('startTarget'));
		deepStrictEqual(starts.slice(-1), ['stack startTarget'], 'Fastify starts last');
		ok(calls.includes('postgres afterLoad 1'));
		ok(calls.includes('postgres snapshot 1'));
		const stops = calls.filter((c) => c.includes('stopTarget'));
		strictEqual(stops[0], 'stack stopTarget 3', 'the front stops first');
		strictEqual(stops.length, 3);
	} finally {
		server.close();
	}
});

test('a part that fails to start stops the parts already up', async () => {
	const { session, calls } = fakeRemote('http://127.0.0.1:1', 'stack');
	await rejects(
		withRemoteTarget(session, 'pg-redis', async () => {}, { topology: 'b' }),
		/stack did not start/
	);
	deepStrictEqual(
		calls.filter((c) => c.includes('stopTarget')).sort(),
		['postgres stopTarget 1', 'redis stopTarget 2'].sort()
	);
});

const gcpScript = (script: string, args: string[], env: Record<string, string>) =>
	execAsync('bash', [join(DIR, 'gcp', script), ...args], { env: { ...process.env, ...env } });

test('every VM a run creates is labeled, placed compactly and deleted by GCE after the run limit', async () => {
	const { stdout } = await gcpScript(
		'provision.sh',
		['--dry-run', '--run-id=ycsb-test-7', '--commit=abc', '--topology=ab'],
		{
			YCSB_GCP_PROJECT: 'test-project',
			YCSB_BENCH_IP: '203.0.113.7',
			YCSB_MAX_RUN_DURATION: '6h',
		}
	);
	const commands = stdout.split('\n').filter((line) => line.startsWith('+ gcloud'));
	const creates = commands.filter((c) => c.includes(' compute instances create '));
	deepStrictEqual(
		creates.map((c) => /instances create (\S+)/.exec(c)![1]),
		['generator', 'harper', 'stack', 'redis', 'postgres'].map((role) => `ycsb-test-7-${role}`)
	);
	for (const create of creates) {
		const role = /instances create ycsb-test-7-(\S+)/.exec(create)![1];
		for (const flag of [
			'--max-run-duration=6h',
			'--instance-termination-action=DELETE',
			`--labels=ycsb-bench=true,ycsb-run=ycsb-test-7,ycsb-role=${role}`,
			'--resource-policies=ycsb-test-7-compact',
			'--maintenance-policy=TERMINATE',
			'--zone=us-central1-a',
			'--project=test-project',
			'nic-type=GVNIC',
			'--no-service-account --no-scopes',
		]) {
			ok(create.includes(flag), `${role}: ${flag}`);
		}
		const target = role !== 'generator';
		strictEqual(create.includes('--threads-per-core=1'), target, `${role}: SMT off on targets only`);
		strictEqual(create.includes('--performance-monitoring-unit=architectural'), target, `${role}: vPMU on targets`);
		strictEqual(create.includes('--machine-type=c4-standard-8-lssd'), target);
		strictEqual(create.includes('--machine-type=c4-standard-32'), !target, `${role}: the generator's shape`);
	}
	ok(commands.some((c) => /firewall-rules create ycsb-test-7-ssh .*--source-ranges=203\.0\.113\.7\/32/.test(c)));
	ok(
		commands.some((c) =>
			/resource-policies create group-placement ycsb-test-7-compact .*--collocation=collocated/.test(c)
		)
	);
	ok(!commands.some((c) => c.includes('0.0.0.0/0')), 'nothing opens to the internet');
	const { stdout: a } = await gcpScript(
		'provision.sh',
		['--dry-run', '--run-id=ycsb-test-7', '--commit=abc', '--topology=a'],
		{
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '203.0.113.7',
		}
	);
	strictEqual(a.split('\n').filter((l) => l.includes(' instances create ')).length, 3);
	const { stdout: hyperdisk } = await gcpScript(
		'provision.sh',
		['--dry-run', '--run-id=ycsb-test-8', '--commit=abc', '--topology=a'],
		{ YCSB_GCP_PROJECT: 'p', YCSB_BENCH_IP: '203.0.113.7', YCSB_DATA_DISK_KIND: 'hyperdisk' }
	);
	for (const create of hyperdisk.split('\n').filter((l) => l.includes(' instances create '))) {
		const role = /instances create ycsb-test-8-(\S+)/.exec(create)![1];
		const target = role !== 'generator';
		strictEqual(create.includes('--machine-type=c4-standard-8 '), target, `${role}: the plain shape`);
		strictEqual(
			create.includes(
				`--create-disk=name=ycsb-test-8-${role}-data,device-name=ycsb-data,type=hyperdisk-balanced,size=375GB,provisioned-iops=25000,provisioned-throughput=480,auto-delete=yes`
			),
			target,
			`${role}: one fixed-performance Hyperdisk per target-shaped VM`
		);
		ok(create.includes('ycsb-data-device=google-ycsb-data'), `${role}: the startup script finds the disk`);
	}
});

test('provisioning refuses a bad run id or an unknown public address; teardown finds a run by label and name', async () => {
	await rejects(
		gcpScript('provision.sh', ['--dry-run', '--run-id=Bad_Id'], {
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '203.0.113.7',
		}),
		/run id must/
	);
	await rejects(
		gcpScript('provision.sh', ['--dry-run', '--run-id=ycsb-x1', '--commit=abc'], {
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '',
		}),
		/public IPv4/
	);
	const { stderr } = await gcpScript('teardown.sh', ['--dry-run', 'ycsb-test-7'], { YCSB_GCP_PROJECT: 'p' });
	for (const kind of ['instances', 'resource-policies', 'firewall-rules', 'networks subnets', 'networks', 'disks']) {
		ok(stderr.includes(`compute ${kind} list --project=p --filter=`), kind);
	}
	ok(stderr.includes("--filter=labels.ycsb-run=ycsb-test-7 OR name ~ '^ycsb-test-7-(generator|"));
	await rejects(gcpScript('teardown.sh', ['--all'], { YCSB_GCP_PROJECT: 'p' }), /add --yes/);
});

test('teardown selects a run by its exact names, so one run id never matches a longer one', async () => {
	const { stderr } = await gcpScript('teardown.sh', ['--dry-run', 'ycsb-check'], { YCSB_GCP_PROJECT: 'p' });
	const filters = [...stderr.matchAll(/--filter=(.*?) --format/g)].map((m) => m[1]);
	const regexes = filters.map((f) => new RegExp(/name ~ '([^']+)'/.exec(f)![1]));
	const matched = (name: string) => regexes.some((r) => r.test(name));
	for (const own of [
		'ycsb-check-generator',
		'ycsb-check-postgres',
		'ycsb-check-harper-data',
		'ycsb-check-net',
		'ycsb-check-compact',
		'ycsb-check-ssh',
	])
		ok(matched(own), own);
	for (const other of [
		'ycsb-check-2-generator',
		'ycsb-check-2-harper-data',
		'ycsb-check-2-net',
		'ycsb-checker-net',
		'ycsb-check-netx',
	])
		ok(!matched(other), other);
	ok(
		filters.every((f) => !f.includes('labels.') || f.includes('labels.ycsb-run=ycsb-check ')),
		'the label is exact'
	);
});

test('the full matrix runs every workload once per point, and zones stay in one region', async () => {
	const { stdout } = await gcpScript('run-matrix.sh', ['--plan'], {});
	const sets = stdout
		.trim()
		.split('\n')
		.map((line) => /^(\S+)\s+point (\S+)\s+generator (\S+)\s+max-run (\S+)\s+workloads (\S+)$/.exec(line)!)
		.map(([, name, point, , , workloads]) => ({ name, point, workloads: workloads.split(',') }));
	const all = ['C', 'B', 'inspect', 'chain-1', 'chain-2', 'chain-4', 'F'];
	for (const point of ['warm', '2', '8']) {
		const covered = sets.filter((s) => s.point === point).flatMap((s) => s.workloads);
		deepStrictEqual([...covered].sort(), [...all].sort(), `point ${point}: each workload in exactly one set`);
	}
	const { stdout: zones } = await gcpScript(
		'provision.sh',
		['--dry-run', '--run-id=ycsb-z1', '--commit=abc', '--topology=a'],
		{
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '203.0.113.7',
			YCSB_GCP_ZONES: 'us-central1-c us-central1-a',
		}
	);
	const creates = zones.split('\n').filter((l) => l.includes(' instances create '));
	strictEqual(creates.length, 3);
	ok(
		creates.every((c) => c.includes('--zone=us-central1-c')),
		'the first zone of the list'
	);
	await rejects(
		gcpScript('provision.sh', ['--dry-run', '--run-id=ycsb-z2', '--commit=abc'], {
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '203.0.113.7',
			YCSB_GCP_ZONES: 'us-central1-c us-east1-b',
		}),
		/one region/
	);
	await rejects(gcpScript('run-matrix.sh', ['--resume', '--set=2x'], { YCSB_GCP_PROJECT: 'p' }), /--run-id/);
	await rejects(gcpScript('run-matrix.sh', ['--all', '--dry-run'], { YCSB_GCP_PROJECT: 'p' }), /previews one set/);
	// What a set's VMs are created with, not only what --plan prints: config.sh's own defaults must not win.
	const created = async (set: string, env: Record<string, string> = {}) => {
		const { stdout } = await gcpScript('run-matrix.sh', [`--set=${set}`, '--dry-run', '--commit=abc'], {
			YCSB_GCP_PROJECT: 'p',
			YCSB_BENCH_IP: '203.0.113.7',
			...env,
		});
		const creates = stdout.split('\n').filter((l) => l.includes(' instances create '));
		strictEqual(creates.length, 3, set);
		const generator = creates.find((c) => c.includes('-generator '))!;
		return {
			generator: /--machine-type=(\S+)/.exec(generator)![1],
			maxRun: [...new Set(creates.map((c) => /--max-run-duration=(\S+)/.exec(c)![1]))].join(','),
		};
	};
	deepStrictEqual(await created('warm'), { generator: 'c4-standard-32', maxRun: '10h' });
	deepStrictEqual(await created('8x-chain'), { generator: 'c4-standard-16', maxRun: '16h' });
	deepStrictEqual(await created('8x-chain', { YCSB_MAX_RUN_DURATION: '3h', YCSB_GEN_MACHINE_TYPE: 'c4-standard-48' }), {
		generator: 'c4-standard-48',
		maxRun: '3h',
	});
});

test('remote mode defaults Harper threads and Fastify workers to --target-cpus, not to an empty cpu list', () => {
	strictEqual(defaultThreads([0, 2, 4, 6], []), 4);
	strictEqual(defaultThreads([], []), 4);
	strictEqual(defaultThreads([], ['--target-cpus=2']), 2);
	throws(() => defaultThreads([], ['--target-cpus=0']), /positive integer/);
});

test('a probe opens one window at a time', async () => {
	const probe = localProbe({ targets: { processes: {}, cgroups: {} }, pinned: {}, cpus: [], workDir: DIR });
	const first = probe.beginWindow({});
	await rejects(probe.beginWindow({}), /already open/);
	await first;
	await rejects(probe.beginWindow({}), /already open/);
	// Off Linux the host reading fails (no /proc); the window must be closed after either outcome.
	await probe.endWindow().catch(() => {});
	await rejects(probe.endWindow(), /no measured window is open/);
});
