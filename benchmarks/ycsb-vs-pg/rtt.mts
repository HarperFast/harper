/**
 * TCP round-trip time between two hosts: a one-byte ping-pong over one connection with Nagle off,
 * timed on the client. Both ends are Node, so each round trip includes two event-loop turns; the
 * same probe against 127.0.0.1 measures that floor, which is recorded beside every VPC reading.
 */
import { createServer, connect } from 'node:net';
import { once } from 'node:events';

export interface RttStats {
	count: number;
	p50Us: number;
	p99Us: number;
	meanUs: number;
	minUs: number;
	maxUs: number;
}

export function rttStats(samplesUs: number[]): RttStats {
	if (samplesUs.length === 0) throw new Error('no round trips measured');
	const sorted = [...samplesUs].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
	const round = (us: number) => Math.round(us * 10) / 10;
	return {
		count: sorted.length,
		p50Us: round(at(0.5)),
		p99Us: round(at(0.99)),
		meanUs: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
		minUs: round(sorted[0]),
		maxUs: round(sorted[sorted.length - 1]),
	};
}

export async function startEchoServer(host: string): Promise<{ port: number; close(): Promise<void> }> {
	const server = createServer((socket) => {
		socket.setNoDelay(true);
		socket.on('data', (data) => socket.write(data));
		socket.on('error', () => socket.destroy());
	});
	server.listen(0, host);
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('echo server has no TCP address');
	return {
		port: address.port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export async function pingPong(
	host: string,
	port: number,
	{ count = 2000, warmup = 200, timeoutMs = 30_000 } = {}
): Promise<RttStats> {
	const socket = connect({ host, port });
	socket.setNoDelay(true);
	const timer = setTimeout(() => socket.destroy(new Error(`RTT probe to ${host}:${port} timed out`)), timeoutMs);
	try {
		await once(socket, 'connect');
		const byte = Buffer.from([0x2a]);
		const samples: number[] = [];
		let pending: ((error?: Error) => void) | undefined;
		socket.on('data', () => pending?.());
		const failed = new Promise<never>((_, reject) => {
			socket.once('error', reject);
			socket.once('close', () => reject(new Error(`RTT probe connection to ${host}:${port} closed`)));
		});
		failed.catch(() => {});
		for (let i = 0; i < warmup + count; i++) {
			const start = process.hrtime.bigint();
			const echoed = new Promise<void>((resolve) => (pending = resolve));
			socket.write(byte);
			await Promise.race([echoed, failed]);
			if (i >= warmup) samples.push(Number(process.hrtime.bigint() - start) / 1000);
		}
		return rttStats(samples);
	} finally {
		clearTimeout(timer);
		socket.destroy();
	}
}
