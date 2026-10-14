const base = process.argv[2];
const seconds = Number(process.argv[3] || 20);
const concurrency = Number(process.argv[4] || 50);
const method = process.argv[5] || 'GET';
const lat = [];
let done = 0,
	failed = 0;
const until = Date.now() + seconds * 1000;
const path = process.env.BENCH_PATH || '/Probe/1';
const headers = { 'content-type': 'application/json' };
if (process.env.BENCH_AUTH) headers.authorization = 'Basic ' + Buffer.from(process.env.BENCH_AUTH).toString('base64');
const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
const init = hasBody
	? { method, headers, body: process.env.BENCH_BODY || '{"id":"1","name":"a"}' }
	: { method, headers };
async function loop() {
	while (Date.now() < until) {
		const t0 = performance.now();
		try {
			const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(10_000) });
			await r.arrayBuffer();
			if (!r.ok) {
				failed++;
				continue;
			}
			lat.push(performance.now() - t0);
			done++;
		} catch {
			failed++;
		}
	}
}
const startedAt = Date.now();
await Promise.all(Array.from({ length: concurrency }, loop));
const elapsed = (Date.now() - startedAt) / 1000;
lat.sort((a, b) => a - b);
if (!lat.length) {
	console.log(JSON.stringify({ method, reqPerSec: 0, failed }));
	process.exit(1);
}
const p = (q) => Number(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(3));
console.log(
	JSON.stringify({ method, reqPerSec: Math.round(done / elapsed), p50: p(0.5), p90: p(0.9), p99: p(0.99), failed })
);
