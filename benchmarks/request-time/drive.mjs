const base = process.argv[2];
const seconds = Number(process.argv[3] || 20);
const concurrency = Number(process.argv[4] || 50);
const method = process.argv[5] || 'GET';
const lat = [];
let done = 0,
	failed = 0;
const until = Date.now() + seconds * 1000;
const init =
	method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: '{"id":"1","name":"a"}' };
async function loop() {
	while (Date.now() < until) {
		const t0 = performance.now();
		try {
			const r = await fetch(base + '/Probe/1', init);
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
await Promise.all(Array.from({ length: concurrency }, loop));
lat.sort((a, b) => a - b);
const p = (q) => Number(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(3));
console.log(
	JSON.stringify({ method, reqPerSec: Math.round(done / seconds), p50: p(0.5), p90: p(0.9), p99: p(0.99), failed })
);
