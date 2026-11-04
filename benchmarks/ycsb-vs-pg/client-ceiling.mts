/**
 * Measures the load generator's own ceiling so a reported throughput can be read
 * as "the server's limit" rather than "the client's limit".
 *
 * Serves a fixed, pre-serialized YCSB-shaped record from memory over a node:http cluster on the
 * target cores (nothing to look up, no database), then drives it with the SAME sharded driver,
 * on the same generator cores, that run-compare.mts uses. Workload C runs on every shard;
 * workload E falls back to one shard (it inserts), so its ceiling is measured separately.
 *
 *   node benchmarks/ycsb-vs-pg/client-ceiling.mts --target-cpus=4 --concurrency=64
 */
import cluster from 'node:cluster';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startDriver } from './shardedDriver.mts';
import {
	readTopology,
	chooseCpuSets,
	assertDisjointCores,
	parseCpuList,
	pinPid,
	verifyAffinity,
} from './resources.mts';

const { values } = parseArgs({
	options: {
		'concurrency': { type: 'string', default: '64' },
		'target-cpus': { type: 'string', default: '4' },
		'serverCpus': { type: 'string' },
		'driverCpus': { type: 'string' },
		'shards': { type: 'string', default: '4' },
		'records': { type: 'string', default: '200000' },
		'ops': { type: 'string', default: '300000' },
		'port': { type: 'string', default: '9941' },
		'serve': { type: 'string' },
	},
});
const PORT = Number(values.port);

if (values.serve) {
	// Server mode: a node:http cluster, one worker per target core, already pinned by taskset.
	const record: Record<string, string> = { id: 'user0000000001' };
	for (let i = 0; i < 10; i++) record[`field${i}`] = 'x'.repeat(100);
	const body = Buffer.from(JSON.stringify(record));
	if (cluster.isPrimary) {
		const workers = Number(values.serve);
		for (let i = 0; i < workers; i++) cluster.fork();
		let ready = 0;
		cluster.on('message', () => {
			if (++ready === workers) process.stdout.write('CEILING_SERVER_READY\n');
		});
	} else {
		http
			.createServer((req, res) => {
				req.resume();
				req.on('end', () => {
					res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
					res.end(body);
				});
			})
			.listen({ port: PORT, host: '127.0.0.1', reusePort: true }, () => process.send!('ready'));
	}
} else {
	const topology = readTopology();
	const { server, driver } =
		values.serverCpus && values.driverCpus
			? { server: parseCpuList(values.serverCpus), driver: parseCpuList(values.driverCpus) }
			: chooseCpuSets(topology, Number(values['target-cpus']));
	assertDisjointCores(topology, server, driver);
	await pinPid(process.pid, driver);

	const child = spawn(
		'taskset',
		['-c', server.join(','), process.execPath, import.meta.filename, `--serve=${server.length}`, `--port=${PORT}`],
		{ stdio: ['ignore', 'pipe', 'inherit'] }
	);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('ceiling server did not start')), 30_000);
			child.stdout!.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('CEILING_SERVER_READY')) {
					clearTimeout(timer);
					resolve();
				}
			});
			child.on('exit', (code) => reject(new Error(`ceiling server exited with ${code}`)));
		});
		verifyAffinity('ceiling-server', child.pid!, server);

		const records = Number(values.records);
		const driverRun = await startDriver({
			baseUrl: `http://127.0.0.1:${PORT}`,
			table: 'usertable',
			records,
			opsPerWorkload: Number(values.ops),
			concurrency: Number(values.concurrency),
			shards: Number(values.shards),
			shape: { fieldCount: 10, fieldLength: 100 },
			keyWidth: Math.max(10, String(records + Number(values.ops)).length),
			maxScanLength: 100,
		});
		try {
			for (const pid of driverRun.pids) verifyAffinity('generator', pid, driver);
			await driverRun.runWorkload('C', 'uniform', 20_000); // sockets and JIT
			for (const workload of ['C', 'E']) {
				const before = cpuOf(driverRun.pids);
				const result = await driverRun.runWorkload(workload);
				const generatorCores = (cpuOf(driverRun.pids) - before) / (result.elapsedMs / 1000);
				console.log(
					`CLIENT_CEILING workload=${workload} shards=${driverRun.shardsUsed(workload)} ` +
						`concurrency=${values.concurrency} server_cpus=${server.join(',')} generator_cpus=${driver.join(',')} ` +
						`ops_per_sec=${result.throughput.toFixed(0)} errors=${result.errors} ` +
						`generator_busy_cores=${generatorCores.toFixed(2)}`
				);
			}
		} finally {
			await driverRun.close();
		}
	} finally {
		child.kill('SIGKILL');
	}
}

function cpuOf(pids: number[]): number {
	let total = 0;
	for (const pid of pids) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			total += (Number(fields[11]) + Number(fields[12])) / 100;
		} catch {
			// exited
		}
	}
	return total;
}
