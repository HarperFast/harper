/**
 * Benchmark: QoS 2 PUBREL latency with real network clients. The real MQTT TCP listener runs in this process; the
 * clients run in a child process over loopback, each a durable session subscribed at QoS 2 to one record topic. A
 * client answers each PUBLISH with a PUBREC at once and each PUBREL with a PUBCOMP, and times PUBREC -> PUBREL on
 * its own clock, so the server's event loop does not schedule the clients' answers. The server writes in batches
 * of QOS2_BENCH_INFLIGHT and waits for every client to have the batch's PUBRELs before the next (closed loop), or
 * writes them all at once (QOS2_BENCH_FLAT=1).
 * Run via: npm run build && npx mocha unitTests/server/mqttQos2Latency.bench.js
 * QOS2_BENCH_CONNECTIONS (comma list, default 10,100), QOS2_BENCH_WRITES (600), QOS2_BENCH_INFLIGHT (8);
 * QOS2_BENCH_OUT appends one JSON line per case, for A/B runs.
 */
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS ??= String(24 * 60 * 60 * 1000);
const PUBLISH = 3;
const CONNACK = 2;
const PUBREL = 6;
const SUBACK = 9;

function runClients() {
	const net = require('node:net');
	const { generate } = require('mqtt-packet');
	let latencies = [];
	let completed = 0;
	let target = Infinity;
	const sockets = [];
	const check = () => {
		if (completed >= target) {
			const sorted = latencies.sort((a, b) => a - b);
			const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
			process.send({ completed, p50: at(0.5), p99: at(0.99), count: sorted.length });
			latencies = [];
			target = Infinity;
		}
	};
	process.on('message', async (message) => {
		if (message.open) {
			const { port, prefix, topic, count } = message.open;
			let subacks = 0;
			let ready;
			const allReady = new Promise((resolve) => (ready = resolve));
			for (let i = 0; i < count; i++) {
				const socket = net.connect({ port, host: '127.0.0.1', noDelay: true });
				const sentAt = new Map();
				let pending = null;
				socket.on('data', (data) => {
					let buffer = pending ? Buffer.concat([pending, data]) : data;
					let offset = 0;
					const out = [];
					for (;;) {
						if (buffer.length - offset < 2) break;
						let length = 0;
						let multiplier = 1;
						let index = offset + 1;
						let byte;
						do {
							if (index >= buffer.length) break;
							byte = buffer[index++];
							length += (byte & 0x7f) * multiplier;
							multiplier *= 128;
						} while (byte & 0x80);
						if (byte & 0x80 || index + length > buffer.length) break;
						const type = buffer[offset] >> 4;
						if (type === PUBLISH) {
							// QoS 2: topic length, topic, then the packet id
							const topicLength = buffer.readUInt16BE(index);
							const id = buffer.readUInt16BE(index + 2 + topicLength);
							out.push(0x50, 2, id >> 8, id & 0xff);
							sentAt.set(id, performance.now());
						} else if (type === PUBREL) {
							const id = buffer.readUInt16BE(index);
							const at = sentAt.get(id);
							if (at !== undefined) {
								latencies.push(performance.now() - at);
								sentAt.delete(id);
							}
							out.push(0x70, 2, id >> 8, id & 0xff);
							completed++;
						} else if (type === CONNACK) {
							socket.write(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 2, rh: 2 }] }));
						} else if (type === SUBACK && ++subacks === count) ready();
						offset = index + length;
					}
					pending = offset < buffer.length ? buffer.subarray(offset) : null;
					// a prompt client answers what one read brought in one write
					if (out.length) socket.write(Buffer.from(out));
					check();
				});
				socket.on('error', (error) => process.send({ failed: `connection ${i}: ${error.message}` }));
				socket.write(
					generate({
						cmd: 'connect',
						protocolId: 'MQTT',
						protocolVersion: 4,
						clientId: `${prefix}-${i}`,
						clean: false,
					})
				);
				sockets.push(socket);
				if (i % 100 === 99) await new Promise((resolve) => setImmediate(resolve));
			}
			await allReady;
			process.send({ ready: count });
		} else if (message.until !== undefined) {
			target = message.until;
			check();
		} else if (message.exit) {
			for (const socket of sockets) socket.resetAndDestroy();
			process.exit(0);
		}
	});
}

if (process.env.QOS2_BENCH_CLIENT) runClients();
else {
	const net = require('node:net');
	const { fork } = require('node:child_process');
	const { appendFileSync } = require('node:fs');
	const { EventEmitter } = require('node:events');
	const { setupTestDBPath } = require('../testUtils.js');
	const { table } = require('#src/resources/databases');
	const Resources = require('#src/resources/Resources');
	const { transaction } = require('#src/resources/transaction');
	const { handleApplication, bypassAuth } = require('#src/server/mqtt');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	require('#src/server/serverHelpers/serverUtilities');

	const CONNECTION_COUNTS = (process.env.QOS2_BENCH_CONNECTIONS ?? '10,100').split(',').map(Number);
	const WRITES = Number(process.env.QOS2_BENCH_WRITES ?? 600);
	const INFLIGHT = Number(process.env.QOS2_BENCH_INFLIGHT ?? 8);
	const FLAT = process.env.QOS2_BENCH_FLAT === '1';
	const cpuMicros = () => {
		const { user, system } = process.threadCpuUsage?.() ?? process.cpuUsage();
		return user + system;
	};

	describe('MQTT QoS 2 latency over TCP (bench)', function () {
		this.timeout(600_000);
		let port;
		let socketServer;
		let restoreAuth;
		let tableCount = 0;
		before(async () => {
			setupTestDBPath();
			setMainIsWorker(true);
			if (!Resources.resources) Resources.resetResources();
			restoreAuth = bypassAuth();
			let listener;
			handleApplication({
				options: { getAll: () => ({ network: { port: 1 } }) },
				server: {
					ws: () => [],
					socket: (fn) => ((listener = fn), {}),
					mqtt: { sessions: new Set(), events: new EventEmitter() },
				},
			});
			socketServer = net.createServer({ noDelay: true, keepAlive: true }, (socket) => listener(socket));
			await new Promise((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
			port = socketServer.address().port;
		});
		after(() => {
			restoreAuth?.();
			socketServer?.close();
		});

		for (const connections of CONNECTION_COUNTS) {
			it(`${connections} durable QoS 2 subscribers`, async () => {
				const name = `Qos2Latency${++tableCount}`;
				const T = table({
					table: name,
					database: 'mqtt_qos2_latency',
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
				});
				Resources.resources.set(name, T, { mqtt: true });
				const child = fork(__filename, [], { env: { ...process.env, QOS2_BENCH_CLIENT: '1' }, execArgv: [] });
				const replies = [];
				let waiting;
				child.on('message', (message) => {
					if (message.failed) throw new Error(message.failed);
					if (waiting) {
						const resolve = waiting;
						waiting = null;
						resolve(message);
					} else replies.push(message);
				});
				const next = () =>
					replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => (waiting = resolve));
				child.send({ open: { port, prefix: name, topic: `${name}/r0`, count: connections } });
				await next();
				const p50s = [];
				const p99s = [];
				let completed = 0;
				const startCpu = cpuMicros();
				const start = performance.now();
				const batch = FLAT ? WRITES : INFLIGHT;
				for (let written = 0; written < WRITES; written += batch) {
					await transaction({}, async (context) => {
						for (let j = 0; j < batch; j++) await T.publish('r0', { value: written + j }, context);
					});
					completed += batch * connections;
					child.send({ until: completed });
					const reply = await next();
					p50s.push(reply.p50);
					p99s.push(reply.p99);
				}
				const elapsed = performance.now() - start;
				const cpu = cpuMicros() - startCpu;
				child.send({ exit: true });
				const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
				const row = {
					connections,
					'inflight': batch,
					'µs/delivery': +(cpu / (WRITES * connections)).toFixed(3),
					'PUBREL ms p50': +median(p50s).toFixed(3),
					'PUBREL ms p99': +median(p99s).toFixed(3),
					'wall ms': Math.round(elapsed),
				};
				console.table([row]);
				if (process.env.QOS2_BENCH_OUT) appendFileSync(process.env.QOS2_BENCH_OUT, JSON.stringify(row) + '\n');
			});
		}
	});
}
