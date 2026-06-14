/**
 * REST transport for the YCSB workload runner.
 *
 * Maps CRUD operations onto Harper's HTTP REST interface:
 *   read   -> GET    /<table>/<key>
 *   insert -> PUT    /<table>/<key>   (full record)
 *   update -> PUT    /<table>/<key>   (full record replace)
 *   rmw    -> GET then PUT
 *   scan   -> GET    /<table>/?id>=<startKey>&limit(<count>)
 *
 * Uses node:http(s) with a keep-alive agent (no external dependency) so the
 * client's connection pool is sized to the configured concurrency and never
 * becomes the bottleneck. Across multiple base URLs it round-robins requests,
 * which is how the cluster benchmark spreads load over nodes.
 */
import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { OpExecutor } from './workload.mts';

interface Endpoint {
	lib: typeof http | typeof https;
	hostname: string;
	port: number;
	agent: http.Agent;
}

export interface RestClientOptions {
	baseUrls: string[];
	table: string;
	maxSockets: number;
	auth?: { username: string; password: string };
	/** Per-request timeout; a hung socket otherwise blocks a closed-loop worker forever. */
	requestTimeoutMs?: number;
}

export interface RestExecutor extends OpExecutor {
	close(): void;
}

export function createRestExecutor(options: RestClientOptions): RestExecutor {
	const { table } = options;
	const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	const authHeader = options.auth
		? 'Basic ' + Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')
		: undefined;

	const endpoints: Endpoint[] = options.baseUrls.map((raw) => {
		const url = new URL(raw);
		const secure = url.protocol === 'https:';
		const lib = secure ? https : http;
		return {
			lib,
			hostname: url.hostname,
			port: Number(url.port) || (secure ? 443 : 80),
			agent: new lib.Agent({ keepAlive: true, maxSockets: options.maxSockets, maxFreeSockets: options.maxSockets }),
		};
	});

	let cursor = 0;
	const nextEndpoint = (): Endpoint => endpoints[cursor++ % endpoints.length];

	function send(method: string, path: string, body?: Buffer): Promise<Buffer> {
		const endpoint = nextEndpoint();
		const headers: Record<string, string> = {};
		if (authHeader) headers.authorization = authHeader;
		if (body) {
			headers['content-type'] = 'application/json';
			headers['content-length'] = String(body.length);
		}
		return new Promise<Buffer>((resolve, reject) => {
			const req = endpoint.lib.request(
				{ hostname: endpoint.hostname, port: endpoint.port, path, method, headers, agent: endpoint.agent },
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('end', () => {
						const status = res.statusCode ?? 0;
						if (status >= 200 && status < 300) {
							resolve(Buffer.concat(chunks));
						} else {
							reject(new Error(`${method} ${path} -> ${status}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
						}
					});
					res.on('error', reject);
				}
			);
			req.on('error', reject);
			req.setTimeout(requestTimeoutMs, () =>
				req.destroy(new Error(`${method} ${path} timed out after ${requestTimeoutMs}ms`))
			);
			if (body) req.write(body);
			req.end();
		});
	}

	const recordPath = (key: string): string => `/${table}/${key}`;

	return {
		async read(key: string): Promise<void> {
			await send('GET', recordPath(key));
		},
		async insert(key: string, record: Record<string, string>): Promise<void> {
			await send('PUT', recordPath(key), Buffer.from(JSON.stringify(record)));
		},
		async update(key: string, record: Record<string, string>): Promise<void> {
			await send('PUT', recordPath(key), Buffer.from(JSON.stringify(record)));
		},
		async readModifyWrite(key: string, record: Record<string, string>): Promise<void> {
			await send('GET', recordPath(key));
			await send('PUT', recordPath(key), Buffer.from(JSON.stringify(record)));
		},
		async scan(startKey: string, count: number): Promise<void> {
			await send('GET', `/${table}/?id>=${startKey}&limit(${count})`);
		},
		close(): void {
			for (const endpoint of endpoints) endpoint.agent.destroy();
		},
	};
}
