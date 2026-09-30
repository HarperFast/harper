/**
 * Load-generator child process for run.mts, driven over IPC. Holds connections with raw `ws` plus
 * mqtt-packet so one process can hold tens of thousands of them; also publishes (MQTT or REST PUT).
 */
import WebSocket from 'ws';
import http from 'node:http';
import mqttPacket from 'mqtt-packet';

type Protocol = 'mqtt' | 'ws';

interface ConnectCommand {
	cmd: 'connect';
	host: string;
	port: number;
	protocol: Protocol;
	/** global index of this command's first connection: topics and client ids are assigned by global index */
	startIndex: number;
	count: number;
	subsPerConn: number;
	topics: number;
	sourceIps: string[];
	concurrency: number;
	auth: string;
	keepalive: number;
	udsPaths?: string[];
	/** this fraction of connections stop reading once subscribed (slow consumers) */
	slowFraction?: number;
}

interface PublishCommand {
	cmd: 'publish';
	host: string;
	port: number;
	mode: 'mqtt' | 'put';
	topics: number;
	/** subscriptions spread over the topics: topic t has floor(K/T) subscribers, plus one when t < K mod T */
	subscriptions: number;
	topicOffset: number;
	/** each PUT creates a new record instead of updating an existing topic record */
	insert?: boolean;
	rate: number;
	payloadBytes: number;
	durationMs: number;
	auth: string;
}

const PORTS_PER_SOURCE_IP = 25_000;
const HIST_SCALE = 8; // buckets per power of two of microseconds
const HIST_SIZE = HIST_SCALE * 32;
const TIMESTAMP_FIELD = Buffer.from('"t":');

const stats = {
	connected: 0,
	failed: 0,
	closed: 0,
	subscribed: 0,
	received: 0,
	receivedBytes: 0,
	latencyMisses: 0,
	published: 0,
	publishErrors: 0,
	publishCompleted: 0,
	expectedDeliveries: 0,
	latencyHist: new Array<number>(HIST_SIZE).fill(0),
	lastError: '',
	closeCodes: {} as Record<string, number>,
};

const sockets: WebSocket[] = [];
// counts every connection this process opens, so source addresses fill in order across commands
let connectionsOpenedHere = 0;

function nowMs() {
	return performance.timeOrigin + performance.now();
}

function recordLatency(buf: Buffer) {
	const at = buf.indexOf(TIMESTAMP_FIELD);
	if (at < 0) {
		stats.latencyMisses++;
		return;
	}
	const start = at + TIMESTAMP_FIELD.length;
	const sentAt = parseFloat(buf.toString('latin1', start, Math.min(buf.length, start + 24)));
	if (!(sentAt > 0)) {
		stats.latencyMisses++;
		return;
	}
	const us = Math.max(0, (nowMs() - sentAt) * 1000);
	stats.latencyHist[Math.min(HIST_SIZE - 1, Math.floor(Math.log2(us + 1) * HIST_SCALE))]++;
}

function topicFor(connIndex: number, sub: number, subsPerConn: number, topics: number) {
	return (connIndex * Math.max(1, subsPerConn) + sub) % topics;
}

function openConnection(cmd: ConnectCommand, index: number): Promise<void> {
	const globalIndex = cmd.startIndex + index;
	const localAddress = cmd.sourceIps[Math.floor(connectionsOpenedHere++ / PORTS_PER_SOURCE_IP) % cmd.sourceIps.length];
	const path = cmd.protocol === 'mqtt' ? '/mqtt' : `/Bench/${topicFor(globalIndex, 0, 1, cmd.topics)}`;
	const slow = cmd.slowFraction ? globalIndex % Math.round(1 / cmd.slowFraction) === 0 : false;
	return new Promise((resolve) => {
		const url = cmd.udsPaths?.length
			? `ws+unix:${cmd.udsPaths[globalIndex % cmd.udsPaths.length]}:${path}`
			: `ws://${cmd.host}:${cmd.port}${path}`;
		const ws = new WebSocket(url, cmd.protocol === 'mqtt' ? ['mqtt'] : [], {
			localAddress,
			perMessageDeflate: false,
			headers: { authorization: cmd.auth },
			handshakeTimeout: 60_000,
		});
		let opened = false;
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			if (slow && opened) (ws as any)._socket.pause();
			resolve();
		};
		ws.on('error', (error) => {
			if (!opened) stats.failed++;
			stats.lastError = error.message;
			done();
		});
		ws.on('close', (code) => {
			if (opened) {
				stats.closed++;
				stats.closeCodes[code] = (stats.closeCodes[code] ?? 0) + 1;
			}
			done();
		});
		ws.on('open', () => {
			opened = true;
			stats.connected++;
			sockets.push(ws);
			if (cmd.protocol === 'ws') {
				stats.subscribed++;
				ws.on('message', (data: Buffer) => {
					stats.received++;
					stats.receivedBytes += data.length;
					recordLatency(data);
				});
				return done();
			}
			const parser = mqttPacket.parser({ protocolVersion: 4 });
			ws.on('message', (data: Buffer) => parser.parse(data));
			parser.on('error', (error) => (stats.lastError = error.message));
			parser.on('packet', (packet: any) => {
				switch (packet.cmd) {
					case 'connack':
						if (cmd.subsPerConn === 0) return done();
						ws.send(
							mqttPacket.generate({
								cmd: 'subscribe',
								messageId: 1,
								subscriptions: Array.from({ length: cmd.subsPerConn }, (_, sub) => ({
									topic: `Bench/${topicFor(globalIndex, sub, cmd.subsPerConn, cmd.topics)}`,
									qos: 0,
								})),
							} as any)
						);
						return;
					case 'suback':
						stats.subscribed += packet.granted.filter((code: number) => code < 0x80).length;
						return done();
					case 'publish':
						stats.received++;
						stats.receivedBytes += packet.payload.length;
						recordLatency(packet.payload);
				}
			});
			ws.send(
				mqttPacket.generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clean: true,
					clientId: `b${cmd.startIndex}-${globalIndex}`,
					keepalive: cmd.keepalive,
				} as any)
			);
			if (cmd.keepalive > 0) {
				// the server drops a client silent for 1.5 × keepalive: ping every 0.75 × keepalive, first ping jittered within that
				const ping = mqttPacket.generate({ cmd: 'pingreq' } as any);
				const period = cmd.keepalive * 750;
				const sendPing = () => ws.readyState === WebSocket.OPEN && ws.send(ping);
				let interval: NodeJS.Timeout | undefined;
				const first = setTimeout(() => {
					sendPing();
					interval = setInterval(sendPing, period);
				}, Math.random() * period);
				ws.on('close', () => {
					clearTimeout(first);
					clearInterval(interval);
				});
			}
		});
	});
}

async function connectAll(cmd: ConnectCommand) {
	let next = 0;
	const worker = async () => {
		while (next < cmd.count) await openConnection(cmd, next++);
	};
	await Promise.all(Array.from({ length: cmd.concurrency }, worker));
}

let padding = '';
function makePayload(bytes: number, seq: number) {
	const prefix = `{"t":${nowMs().toFixed(3)},"s":${seq},"p":"`;
	const padLength = Math.max(0, bytes - prefix.length - 2);
	if (padding.length < padLength) padding = 'x'.repeat(padLength);
	return prefix + padding.slice(0, padLength) + '"}';
}

let publisherSocket: WebSocket | undefined;
let putAgent: http.Agent | undefined;
let insertSequence = 0;
function connectPublisher(cmd: PublishCommand): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://${cmd.host}:${cmd.port}/mqtt`, ['mqtt'], {
			perMessageDeflate: false,
			headers: { authorization: cmd.auth },
		});
		ws.on('error', reject);
		ws.on('close', (code) => {
			publisherSocket = undefined;
			reject(new Error(`publisher connection closed (${code}) before CONNACK`));
		});
		ws.on('open', () => {
			const parser = mqttPacket.parser({ protocolVersion: 4 });
			ws.on('message', (data: Buffer) => parser.parse(data));
			parser.on('error', reject);
			parser.on('packet', (packet: any) => packet.cmd === 'connack' && resolve(ws));
			ws.send(
				mqttPacket.generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clean: true,
					clientId: `pub${process.pid}`,
					keepalive: 0,
				} as any)
			);
		});
	});
}

async function publish(cmd: PublishCommand) {
	let send: (topic: number | string, seq: number) => void;
	if (cmd.mode === 'mqtt') {
		publisherSocket ??= await connectPublisher(cmd);
		const ws = publisherSocket;
		send = (topic, seq) => {
			if (ws.readyState !== WebSocket.OPEN) throw new Error('publisher connection closed mid-rate');
			ws.send(
				mqttPacket.generate({
					cmd: 'publish',
					topic: `Bench/${topic}`,
					payload: Buffer.from(makePayload(cmd.payloadBytes, seq)),
					qos: 0,
					retain: false,
				} as any)
			);
		};
	} else {
		putAgent ??= new http.Agent({ keepAlive: true, maxSockets: 64 });
		const agent = putAgent;
		send = (topic, seq) => {
			const body = makePayload(cmd.payloadBytes, seq);
			const req = http.request(
				{
					host: cmd.host,
					port: cmd.port,
					path: `/Bench/${topic}`,
					method: 'PUT',
					agent,
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(body),
						'authorization': cmd.auth,
					},
				},
				(res) => {
					res.resume();
					if (res.statusCode! >= 300) stats.publishErrors++;
					else stats.publishCompleted++;
				}
			);
			req.on('error', () => stats.publishErrors++);
			req.end(body);
		};
	}
	const baseSubscribers = Math.floor(cmd.subscriptions / cmd.topics);
	const extraSubscribers = cmd.subscriptions % cmd.topics;
	const TICK_MS = 5;
	const start = performance.now();
	let sent = 0;
	let next = cmd.topicOffset;
	while (performance.now() - start < cmd.durationMs) {
		const target = Math.floor(((performance.now() - start) / 1000) * cmd.rate);
		while (sent < target) {
			if (cmd.insert) {
				send(`new-${process.pid}-${insertSequence++}`, sent++);
			} else {
				const topic = next++ % cmd.topics;
				send(topic, sent++);
				stats.expectedDeliveries += baseSubscribers + (topic < extraSubscribers ? 1 : 0);
			}
			stats.published++;
		}
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}
}

process.on('message', async (message: any) => {
	try {
		switch (message.cmd) {
			case 'connect':
				await connectAll(message);
				break;
			case 'publish':
				await publish(message);
				break;
			case 'close':
				for (const ws of sockets) ws.terminate();
				publisherSocket?.terminate();
				setTimeout(() => process.exit(0), 100);
		}
		process.send!({ reply: message.cmd, ...snapshot() });
	} catch (error) {
		process.send!({ reply: message.cmd, error: (error as Error).message });
	}
});

function snapshot() {
	return { ...stats, open: stats.connected - stats.closed, rss: process.memoryUsage().rss };
}
