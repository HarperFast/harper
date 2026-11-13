/**
 * Inbound parsing cost when packets straddle reads, as raw TCP delivers them: MQTT_INGEST_BENCH_CONNECTIONS
 * connections each read a run of PINGREQs in MQTT_INGEST_BENCH_CHUNK-byte reads, so most reads end mid-packet,
 * MQTT_INGEST_BENCH_ROUNDS times, with every connection's read of a round taken before any connection's next.
 * Reports ns per packet and the mqtt-packet parsers made. A manual run, not part of CI:
 *
 *   npx mocha unitTests/server/mqttIngest.bench.js
 *
 * MQTT_INGEST_BENCH_OUT appends the result as a JSON line.
 */
const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const Resources = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const mqttPacket = require('mqtt-packet');
const Parser = require('mqtt-packet/parser');
require('#src/server/serverHelpers/serverUtilities');

const CONNECTIONS = Number(process.env.MQTT_INGEST_BENCH_CONNECTIONS ?? 1000);
const ROUNDS = Number(process.env.MQTT_INGEST_BENCH_ROUNDS ?? 200);
const CHUNK = Number(process.env.MQTT_INGEST_BENCH_CHUNK ?? 3);
const PACKETS_PER_ROUND = 8;

const user = { username: 'mqtt-ingest-bench', role: { permission: { super_user: true } } };

describe('MQTT ingest of packets split across reads (bench)', function () {
	this.timeout(600_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('parses packets that straddle reads over many connections', async () => {
		let listener;
		handleApplication({
			options: { getAll: () => ({ webSocket: {} }) },
			server: {
				ws: (fn) => ((listener = fn), []),
				socket: () => ({}),
				mqtt: { sessions: new Set(), events: new EventEmitter() },
			},
		});
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
		const connections = [];
		let responses = 0;
		for (let i = 0; i < CONNECTIONS; i++) {
			const rawSocket = new EventEmitter();
			rawSocket.remoteAddress = '127.0.0.1';
			const socket = { handlers: {}, _socket: rawSocket, close() {}, terminate() {}, destroy() {} };
			socket.send = () => responses++;
			socket.on = (event, handler) => (socket.handlers[event] = handler);
			listener(socket, request, Promise.resolve({ status: 200 }), () => {});
			connections.push(socket);
		}
		for (let i = 0; i < CONNECTIONS; i++) {
			connections[i].handlers.message(
				mqttPacket.generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clientId: `ingest-${i}`,
					clean: true,
				})
			);
		}
		while (responses < CONNECTIONS) await new Promise((resolve) => setImmediate(resolve));
		const run = Buffer.concat(Array.from({ length: PACKETS_PER_ROUND }, () => mqttPacket.generate({ cmd: 'pingreq' })));
		const chunks = [];
		for (let offset = 0; offset < run.length; offset += CHUNK) chunks.push(run.subarray(offset, offset + CHUNK));

		// one round untimed, as a connection's first packets are, so what is timed is a steady stream
		for (const chunk of chunks) for (const socket of connections) socket.handlers.message(chunk);
		while (responses < CONNECTIONS * (1 + PACKETS_PER_ROUND)) await new Promise((resolve) => setImmediate(resolve));
		const makeParser = Parser.parser;
		let made = 0;
		Parser.parser = function (options) {
			if (this instanceof Parser) made++;
			return makeParser.call(this, options);
		};
		responses = 0;
		global.gc?.();
		const heapBefore = process.memoryUsage().heapUsed;
		const start = process.hrtime.bigint();
		try {
			for (let round = 0; round < ROUNDS; round++) {
				for (const chunk of chunks) {
					for (const socket of connections) socket.handlers.message(chunk);
				}
			}
		} finally {
			Parser.parser = makeParser;
		}
		const elapsed = Number(process.hrtime.bigint() - start);
		const heapAfter = process.memoryUsage().heapUsed;
		const packets = CONNECTIONS * ROUNDS * PACKETS_PER_ROUND;
		assert.strictEqual(responses, packets, 'every PINGREQ was answered');
		const result = {
			connections: CONNECTIONS,
			rounds: ROUNDS,
			chunk: CHUNK,
			nsPerPacket: Math.round(elapsed / packets),
			parsersMade: made,
			parsersMadePerThousandPackets: Math.round((made / packets) * 1000 * 10) / 10,
			heapGrowthMB: Math.round(((heapAfter - heapBefore) / 1048576) * 10) / 10,
		};
		console.log(JSON.stringify(result));
		if (process.env.MQTT_INGEST_BENCH_OUT)
			appendFileSync(process.env.MQTT_INGEST_BENCH_OUT, JSON.stringify(result) + '\n');
		for (const socket of connections) socket.handlers.close();
	});
});
