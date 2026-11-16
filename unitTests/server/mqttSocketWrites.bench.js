/**
 * Benchmark: what writing MQTT packets to a TCP socket costs the thread that serves it, through the real MQTT
 * TCP listener (server/mqtt.ts) over loopback, or with MQTT_WRITES_BENCH_TRANSPORT=ws its real WebSocket listener
 * behind a `ws` server, with the clients in a child process; the CPU measured is the server thread's alone
 * (process.threadCpuUsage). The clients read promptly. Each case commits its messages in one transaction:
 * - burst: one client, one subscription, MQTT_WRITES_BENCH_BURST QoS 0 messages to one record;
 * - subs: one client, MQTT_WRITES_BENCH_SUBS subscriptions (one record each), the burst spread across them;
 * - fanout: MQTT_WRITES_BENCH_FANOUT clients on one record, one message each;
 * - fanburst: MQTT_WRITES_BENCH_FANBURST clients on one record, MQTT_WRITES_BENCH_FANBURST_EACH messages each.
 * MQTT_WRITES_BENCH_CASES (comma list) picks the cases.
 * Reported per case: server CPU per delivered message, from the commit's start and from the first byte written
 * (delivery alone, without the commit), socket `_write` and `_writev` calls per message (each is
 * one write syscall when the kernel takes it all), the time from the commit's start to the first byte handed to
 * the kernel and until the client has every message, and, on the client, its reads and when the second, middle
 * and last message arrived after the first, and the median client's time from its first message to its last;
 * each the median over MQTT_WRITES_BENCH_ROUNDS rounds.
 * Run via: npm run build && npx mocha unitTests/server/mqttSocketWrites.bench.js
 * (client reads are the socket's 'data' events on either transport).
 * MQTT_WRITES_BENCH_OUT appends one JSON line per case, for A/B runs (MQTT_WRITES_BENCH_LABEL tags it).
 */
// The live-subscription re-check (server/liveSubscriptionAuth.ts, read at load) would revoke the bench user, which
// has no hdb_user row, 30 s in: past that a run would lose its subscriptions and hang.
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS ??= String(24 * 60 * 60 * 1000);
const PUBLISH = 3;
const CONNACK = 2;
const SUBACK = 9;

/** Splits a byte stream into MQTT packets, calling `onPacket(type)` for each. */
function packetCounter(onPacket) {
	let pending = null;
	return (data) => {
		let buffer = pending ? Buffer.concat([pending, data]) : data;
		let offset = 0;
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
			onPacket(buffer[offset] >> 4);
			offset = index + length;
		}
		pending = offset < buffer.length ? buffer.subarray(offset) : null;
	};
}

/** The child process: opens the connections it is told to, and reports once they have the PUBLISHes expected. */
function runClients() {
	const net = require('node:net');
	const { WebSocket } = require('ws');
	const { generate } = require('mqtt-packet');
	let received = 0;
	let reads = 0;
	let target = Infinity;
	const sockets = [];
	let roundFrom = 0;
	let roundReads = 0;
	// when each PUBLISH arrived, by its place in the run
	const arrivals = [];
	// per connection, when its first and last PUBLISH of the round arrived
	let round = 0;
	const connectionRound = [];
	const connectionFirst = [];
	const connectionLast = [];
	const check = () => {
		if (received >= target) {
			// a round's spread: when its second, middle and last message arrived, after its first
			const first = arrivals[roundFrom];
			const at = (index) => Math.round((arrivals[index] - first) * 1000);
			const spreads = [];
			for (let i = 0; i < sockets.length; i++) {
				if (connectionRound[i] === round) spreads.push(connectionLast[i] - connectionFirst[i]);
			}
			spreads.sort((a, b) => a - b);
			process.send({
				reached: received,
				reads: reads - roundReads,
				secondMicros: at(roundFrom + 1),
				middleMicros: at(roundFrom + ((target - roundFrom) >> 1)),
				lastMicros: at(target - 1),
				connectionSpreadMicros: Math.round(spreads[spreads.length >> 1] * 1000),
			});
			round++;
			roundFrom = target;
			roundReads = reads;
			target = Infinity;
		}
	};
	process.on('message', async (message) => {
		if (message.open) {
			const { port, prefix, topicsFor, count, transport } = message.open;
			let subacks = 0;
			let ready;
			const allReady = new Promise((resolve) => (ready = resolve));
			for (let i = 0; i < count; i++) {
				let write;
				const onPackets = packetCounter((type) => {
					if (type === PUBLISH) {
						const now = performance.now();
						arrivals[received++] = now;
						if (connectionRound[i] !== round) {
							connectionRound[i] = round;
							connectionFirst[i] = now;
						}
						connectionLast[i] = now;
					} else if (type === CONNACK) {
						write(
							generate({
								cmd: 'subscribe',
								messageId: 1,
								subscriptions: topicsFor[i % topicsFor.length].map((topic) => ({ topic, qos: 0, rh: 2 })),
							})
						);
					} else if (type === SUBACK && ++subacks === count) ready();
				});
				const connect = generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clientId: `${prefix}-${i}`,
					clean: true,
				});
				// a connection that fails or closes ends the run, rather than leaving the server waiting on it
				const failed = (error) => process.send({ failed: `connection ${i}: ${error?.message ?? 'closed'}` });
				if (transport === 'ws') {
					const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mqtt');
					write = (packet) => ws.send(packet);
					ws.on('message', (data) => {
						onPackets(data);
						check();
					});
					ws.on('open', () => {
						ws._socket.on('data', () => reads++);
						write(connect);
					});
					ws.on('error', failed);
					ws.on('close', () => failed());
					sockets.push(() => ws._socket?.resetAndDestroy());
				} else {
					const socket = net.connect({ port, host: '127.0.0.1', noDelay: true });
					write = (packet) => socket.write(packet);
					socket.on('data', (data) => {
						onPackets(data);
						reads++;
						check();
					});
					socket.on('error', failed);
					socket.on('close', () => failed());
					write(connect);
					sockets.push(() => socket.resetAndDestroy());
				}
				if (i % 100 === 99) await new Promise((resolve) => setImmediate(resolve));
			}
			await allReady;
			process.send({ ready: count });
		} else if (message.until !== undefined) {
			target = message.until;
			check();
		} else if (message.status) process.send({ status: { received, target, reads } });
		else if (message.exit) {
			// reset rather than closed, so the thousands of client ports a run uses are not held in TIME_WAIT
			for (const reset of sockets) reset();
			process.exit(0);
		}
	});
}

if (process.env.MQTT_WRITES_BENCH_CLIENT) runClients();
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

	const ROUNDS = Number(process.env.MQTT_WRITES_BENCH_ROUNDS ?? 30);
	const BURST = Number(process.env.MQTT_WRITES_BENCH_BURST ?? 1000);
	const SUBS = Number(process.env.MQTT_WRITES_BENCH_SUBS ?? 10);
	const FANOUT = Number(process.env.MQTT_WRITES_BENCH_FANOUT ?? 1000);
	const FANBURST = Number(process.env.MQTT_WRITES_BENCH_FANBURST ?? 200);
	const FANBURST_EACH = Number(process.env.MQTT_WRITES_BENCH_FANBURST_EACH ?? 10);
	const CASES = (process.env.MQTT_WRITES_BENCH_CASES ?? 'burst,subs,fanout,fanburst').split(',');
	const LABEL = process.env.MQTT_WRITES_BENCH_LABEL ?? '';
	const TRANSPORT = process.env.MQTT_WRITES_BENCH_TRANSPORT ?? 'tcp';

	// the server thread's own CPU: commits and the client process run elsewhere
	const cpuMicros = () => {
		const { user, system } = process.threadCpuUsage?.() ?? process.cpuUsage();
		return user + system;
	};
	const median = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[sorted.length >> 1];
	};

	describe('MQTT socket writes (bench)', function () {
		this.timeout(600_000);
		let port;
		let socketServer;
		let restoreAuth;
		let tableCount = 0;
		const results = [];
		// every accepted socket's write calls, counted from the socket's own `_write`/`_writev`
		const writes = { write: 0, writev: 0, chunks: 0, firstAt: 0n, firstCpu: 0 };
		const firstWrite = () => {
			writes.firstAt = process.hrtime.bigint();
			writes.firstCpu = cpuMicros();
		};
		const countWrites = (socket) => {
			const { _write, _writev } = net.Socket.prototype;
			socket._write = function (chunk, encoding, callback) {
				writes.write++;
				if (writes.firstAt === 0n) firstWrite();
				return _write.call(this, chunk, encoding, callback);
			};
			socket._writev = function (chunks, callback) {
				writes.writev++;
				writes.chunks += chunks.length;
				if (writes.firstAt === 0n) firstWrite();
				return _writev.call(this, chunks, callback);
			};
		};

		before(async () => {
			setupTestDBPath();
			setMainIsWorker(true);
			if (!Resources.resources) Resources.resetResources();
			restoreAuth = bypassAuth();
			let listener;
			let wsListener;
			handleApplication({
				options: { getAll: () => (TRANSPORT === 'ws' ? { webSocket: {} } : { network: { port: 1 } }) },
				server: {
					ws: (fn) => ((wsListener = fn), []),
					socket: (fn) => ((listener = fn), {}),
					mqtt: { sessions: new Set(), events: new EventEmitter() },
				},
			});
			if (TRANSPORT === 'ws') {
				const { WebSocketServer } = require('ws');
				const user = { username: 'mqtt-writes-bench', role: { permission: { super_user: true } } };
				const headers = { 'sec-websocket-protocol': 'mqtt' };
				const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
				socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
				socketServer.on('connection', (ws) => {
					countWrites(ws._socket);
					wsListener(ws, request, Promise.resolve({ status: 200 }), () => {});
				});
				await new Promise((resolve) => socketServer.on('listening', resolve));
			} else {
				// as Harper's own listeners are set up (server/serverRegistry.ts)
				socketServer = net.createServer({ noDelay: true, keepAlive: true }, (socket) => {
					countWrites(socket);
					listener(socket);
				});
				await new Promise((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
			}
			port = socketServer.address().port;
		});
		after(() => {
			restoreAuth?.();
			socketServer?.close();
			console.table(results);
		});

		/** Starts a client process with `count` connections, each subscribed to its entry of `topicsFor`. */
		async function openClients(prefix, count, topicsFor) {
			const child = fork(__filename, [], { env: { ...process.env, MQTT_WRITES_BENCH_CLIENT: '1' }, execArgv: [] });
			const replies = [];
			let waiting;
			let failed;
			const fail = (reason) => {
				failed ??= new Error(`MQTT bench clients: ${reason}`);
				waiting?.reject(failed);
				waiting = null;
			};
			child.on('message', (message) => {
				if (message.failed) return fail(message.failed);
				if (message.status) return fail(`stalled at ${JSON.stringify(message.status)}`);
				if (waiting) {
					const { resolve } = waiting;
					waiting = null;
					resolve(message);
				} else replies.push(message);
			});
			child.on('exit', (code, signal) => fail(`exited (${code ?? signal})`));
			const next = () => {
				if (failed) return Promise.reject(failed);
				if (replies.length) return Promise.resolve(replies.shift());
				return new Promise((resolve, reject) => {
					waiting = { resolve, reject };
					// a run that stops advancing reports where the clients are, rather than waiting out mocha's timeout
					const timer = setTimeout(() => child.send({ status: true }), 30_000);
					const settle = (callback) => (value) => {
						clearTimeout(timer);
						callback(value);
					};
					waiting = { resolve: settle(resolve), reject: settle(reject) };
				});
			};
			child.send({ open: { port, prefix, topicsFor, count, transport: TRANSPORT } });
			await next();
			let delivered = 0;
			return {
				/** Resolves once the clients have `messages` more PUBLISHes than before. */
				receive(messages) {
					delivered += messages;
					child.send({ until: delivered });
					return next();
				},
				close() {
					child.removeAllListeners('exit');
					child.send({ exit: true });
				},
			};
		}

		/**
		 * Commits `write(context)` `rounds` times (plus warm-up), each once the clients have the last one's
		 * `messages` deliveries, and records the case's medians.
		 */
		async function measure(name, clients, messages, write) {
			for (let warm = 0; warm < 5; warm++) {
				const received = clients.receive(messages);
				await transaction({}, write);
				await received;
			}
			const cpuPerMessage = [];
			const deliveryCpuPerMessage = [];
			const writesPerMessage = [];
			const writevsPerMessage = [];
			const firstByteMicros = [];
			const deliveredMicros = [];
			const clientReads = [];
			const secondMicros = [];
			const middleMicros = [];
			const lastMicros = [];
			const connectionSpreadMicros = [];
			for (let round = 0; round < ROUNDS; round++) {
				const received = clients.receive(messages);
				writes.write = writes.writev = writes.chunks = 0;
				writes.firstAt = 0n;
				const startCpu = cpuMicros();
				const start = process.hrtime.bigint();
				await transaction({}, write);
				const reply = await received;
				const end = process.hrtime.bigint();
				const endCpu = cpuMicros();
				cpuPerMessage.push((endCpu - startCpu) / messages);
				deliveryCpuPerMessage.push((endCpu - writes.firstCpu) / messages);
				writesPerMessage.push(writes.write / messages);
				writevsPerMessage.push(writes.writev / messages);
				firstByteMicros.push(Number(writes.firstAt - start) / 1000);
				deliveredMicros.push(Number(end - start) / 1000);
				clientReads.push(reply.reads);
				secondMicros.push(reply.secondMicros);
				middleMicros.push(reply.middleMicros);
				lastMicros.push(reply.lastMicros);
				connectionSpreadMicros.push(reply.connectionSpreadMicros);
			}
			const row = {
				'label': LABEL,
				'transport': TRANSPORT,
				'case': name,
				messages,
				'cpu µs/msg': +median(cpuPerMessage).toFixed(3),
				'delivery cpu µs/msg': +median(deliveryCpuPerMessage).toFixed(3),
				'_write/msg': +median(writesPerMessage).toFixed(3),
				'_writev/msg': +median(writevsPerMessage).toFixed(3),
				'first byte µs': Math.round(median(firstByteMicros)),
				'all received µs': Math.round(median(deliveredMicros)),
				'client reads': median(clientReads),
				'2nd after 1st µs': median(secondMicros),
				'middle after 1st µs': median(middleMicros),
				'last after 1st µs': median(lastMicros),
				'per-client first to last µs': median(connectionSpreadMicros),
			};
			results.push(row);
			if (process.env.MQTT_WRITES_BENCH_OUT)
				appendFileSync(process.env.MQTT_WRITES_BENCH_OUT, JSON.stringify(row) + '\n');
		}

		function newTable() {
			const name = `MqttWrites${++tableCount}`;
			const T = table({
				database: 'mqttwritesbench',
				table: name,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			});
			Resources.resources.set(name, T, { mqtt: true });
			return { T, name };
		}
		const message = (i) => ({ value: i, reading: { a: 1, b: 'two', c: [3, 4, 5] } });

		if (CASES.includes('burst'))
			it(`one client, one subscription, a burst of ${BURST}`, async () => {
				const { T, name } = newTable();
				const clients = await openClients(`burst-${name}`, 1, [[`${name}/r0`]]);
				await measure('burst', clients, BURST, async (context) => {
					for (let i = 0; i < BURST; i++) await T.publish('r0', message(i), context);
				});
				clients.close();
			});

		if (CASES.includes('subs'))
			it(`one client, ${SUBS} subscriptions, a burst of ${BURST} across them`, async () => {
				const { T, name } = newTable();
				const topics = Array.from({ length: SUBS }, (_, s) => `${name}/r${s}`);
				const clients = await openClients(`subs-${name}`, 1, [topics]);
				await measure('subs', clients, BURST, async (context) => {
					for (let i = 0; i < BURST; i++) await T.publish(`r${i % SUBS}`, message(i), context);
				});
				clients.close();
			});

		if (CASES.includes('fanout'))
			it(`${FANOUT} clients, one message each`, async () => {
				const { T, name } = newTable();
				const clients = await openClients(`fanout-${name}`, FANOUT, [[`${name}/r0`]]);
				let sequence = 0;
				await measure('fanout', clients, FANOUT, (context) => T.publish('r0', message(sequence++), context));
				clients.close();
			});

		if (CASES.includes('fanburst'))
			it(`${FANBURST} clients, ${FANBURST_EACH} messages each`, async () => {
				const { T, name } = newTable();
				const clients = await openClients(`fanburst-${name}`, FANBURST, [[`${name}/r0`]]);
				let sequence = 0;
				await measure('fanburst', clients, FANBURST * FANBURST_EACH, async (context) => {
					for (let i = 0; i < FANBURST_EACH; i++) await T.publish('r0', message(sequence++), context);
				});
				clients.close();
			});
	});
}
