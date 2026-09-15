/**
 * Measures the load generator's own ceiling so a reported throughput can be read
 * as "the server's limit" rather than "the client's limit".
 *
 * Serves a fixed, pre-serialized YCSB-shaped record from memory over a node:http
 * cluster (nothing to look up, no database), then drives it with the same
 * restClient + runOperations path the comparison uses. Whatever this reports is
 * the hard upper bound for both targets on this host.
 *
 *   node benchmarks/ycsb-vs-pg/client-ceiling.mts --concurrency=64 --workers=8 --ops=300000
 */
import cluster from 'node:cluster';
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		concurrency: { type: 'string', default: '64' },
		workers: { type: 'string', default: '8' },
		ops: { type: 'string', default: '300000' },
		port: { type: 'string', default: '9941' },
	},
});
const CONCURRENCY = Number(values.concurrency);
const WORKERS = Number(values.workers);
const OPS = Number(values.ops);
const PORT = Number(values.port);

const record: Record<string, string> = { id: 'user0000000001' };
for (let i = 0; i < 10; i++) record[`field${i}`] = 'x'.repeat(100);
const BODY = Buffer.from(JSON.stringify(record));

if (cluster.isPrimary) {
	for (let i = 0; i < WORKERS; i++) cluster.fork();
	let ready = 0;
	cluster.on('message', async () => {
		if (++ready < WORKERS) return;
		const { createRestExecutor } = await import('../ycsb/restClient.mts');
		const { KeyState, runOperations } = await import('../ycsb/workload.mts');
		const executor = createRestExecutor({
			baseUrls: [`http://127.0.0.1:${PORT}`],
			table: 'usertable',
			maxSockets: CONCURRENCY,
		});
		const keys = new KeyState({
			distribution: 'uniform',
			initialKeyCount: 1_000_000,
			keyWidth: 14,
			shape: { fieldCount: 10, fieldLength: 100 },
			maxScanLength: 100,
		});
		// Warm the sockets and the JIT before the timed pass.
		await runOperations({ opCount: 20_000, concurrency: CONCURRENCY, mix: { read: 1 }, executor, keys });
		const result = await runOperations({ opCount: OPS, concurrency: CONCURRENCY, mix: { read: 1 }, executor, keys });
		const cpu = process.cpuUsage();
		console.log(
			`CLIENT_CEILING concurrency=${CONCURRENCY} server_workers=${WORKERS} ops_per_sec=${result.throughput.toFixed(0)} errors=${result.errors} client_cpu_cores=${((cpu.user + cpu.system) / 1000 / result.elapsedMs).toFixed(2)}`
		);
		executor.close();
		process.exit(0);
	});
} else {
	http
		.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json', 'content-length': BODY.length });
			res.end(BODY);
		})
		.listen({ port: PORT, host: '127.0.0.1', reusePort: true }, () => process.send!('ready'));
}
