/**
 * The "conventional Node stack" side of the comparison: Fastify REST endpoints
 * over Postgres (system of record) with Redis as a look-aside cache.
 *
 * Exposes the same routes the YCSB harness drives against Harper:
 *   GET /usertable/<key>                    -> read
 *   PUT /usertable/<key>                    -> insert / update (full record)
 *   GET /usertable/?id>=<key>&limit(<n>)    -> scan
 *   GET /inspect/<key>                      -> 403 unless the caller owns the record, else a projection
 *   GET /chain/<key>?hops=<n>               -> n + 1 dependent reads (../../ycsb/app/dependentReads.mjs)
 *
 * Reads are cache-aside (Redis hit returns the stored JSON verbatim, a miss
 * falls through to Postgres and populates the cache). Writes are write-through:
 * the row is upserted and the cache line replaced, which maximizes hit rate for
 * the read-heavy workloads. Scans bypass the cache, as they would in a real app
 * — a range query can't be served from a key-value cache.
 *
 * Runs one process per core-share via cluster with SO_REUSEPORT, so the kernel
 * balances connections across workers without a primary-process hop — the
 * closest structural match to Harper's multi-threaded HTTP server.
 *
 * With JWT_SECRET set, every request must carry `Authorization: Bearer <JWT>`,
 * verified with @fastify/jwt (fast-jwt, HS256, its default: no verified-token
 * cache) in an onRequest hook, and is rejected with 401 otherwise. The inspect
 * caller is then the token's subject; without JWT_SECRET it is the `x-caller` header.
 */
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import pg from 'pg';
import Redis from 'ioredis';
import { chainRecords, inspectRecord, parseHops } from '../../ycsb/app/dependentReads.mjs';

// 9940, not 9925/9926: those are the ports the integration-test framework probes
// when allocating a loopback address for the Harper side of the comparison.
const PORT = Number(process.env.PORT ?? 9940);
const WORKERS = Number(process.env.WORKERS ?? 4);
const FIELDS = Number(process.env.FIELDS ?? 10);
const POOL_SIZE = Number(process.env.PG_POOL ?? 12);
const USE_CACHE = process.env.USE_CACHE !== 'false';
const PG_URL = process.env.PG_URL ?? 'postgres://ycsb:ycsb@127.0.0.1:5433/ycsb';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const JWT_SECRET = process.env.JWT_SECRET;

const FIELD_NAMES = Array.from({ length: FIELDS }, (_, i) => `field${i}`);

// `id` is selected so the response body matches Harper's, which echoes the primary key.
const SELECT_SQL = `SELECT ${FIELD_NAMES.join(', ')}, id FROM usertable WHERE id = $1`;
const UPSERT_SQL = `INSERT INTO usertable (id, ${FIELD_NAMES.join(', ')})
	VALUES (${Array.from({ length: FIELDS + 1 }, (_, i) => `$${i + 1}`).join(', ')})
	ON CONFLICT (id) DO UPDATE SET ${FIELD_NAMES.map((f) => `${f} = EXCLUDED.${f}`).join(', ')}`;
const SCAN_SQL = `SELECT id, ${FIELD_NAMES.join(', ')} FROM usertable WHERE id >= $1 ORDER BY id LIMIT $2`;

// Harper's scan URL shape: /usertable/?id>=user000001&limit(100)
const SCAN_QUERY = /^id>=([^&]+)&limit\((\d+)\)$/;

async function createSchema() {
	const client = new pg.Client({ connectionString: PG_URL });
	await client.connect();
	await client.query(`CREATE TABLE IF NOT EXISTS usertable (
		id text PRIMARY KEY,
		${FIELD_NAMES.map((f) => `${f} text`).join(',\n\t\t')}
	)`);
	await client.end();
}

async function startWorker() {
	const pool = new pg.Pool({ connectionString: PG_URL, max: POOL_SIZE });
	// Named prepared statements let Postgres skip parse/plan on every request,
	// which is what any production app on `pg` would do.
	const prepared = (name, text, values) => pool.query({ name, text, values });
	const redis = USE_CACHE ? new Redis(REDIS_URL, { enableAutoPipelining: true }) : undefined;

	const app = Fastify({ logger: false });
	if (JWT_SECRET) {
		await app.register(fastifyJwt, { secret: JWT_SECRET, verify: { algorithms: ['HS256'] } });
		app.addHook('onRequest', async (request, reply) => {
			try {
				await request.jwtVerify();
			} catch {
				return reply.code(401).send({ error: 'unauthorized' });
			}
		});
	}

	app.get('/usertable/:id', async (request, reply) => {
		const { id } = request.params;
		if (redis) {
			const cached = await redis.getBuffer(id);
			if (cached) return reply.type('application/json').send(cached);
		}
		const { rows } = await prepared('select_record', SELECT_SQL, [id]);
		if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
		const body = JSON.stringify(rows[0]);
		if (redis) await redis.set(id, body);
		return reply.type('application/json').send(body);
	});

	app.put('/usertable/:id', async (request, reply) => {
		const { id } = request.params;
		const record = request.body;
		const values = [id];
		for (const field of FIELD_NAMES) values.push(record[field] ?? null);
		await prepared('upsert_record', UPSERT_SQL, values);
		if (redis) await redis.set(id, JSON.stringify({ ...record, id }));
		return reply.code(200).send({ id });
	});

	// Scan. Fastify's query parser mangles Harper's `id>=x&limit(n)` syntax, so
	// match against the raw query string instead.
	app.get('/usertable/', async (request, reply) => {
		const query = request.raw.url.slice(request.raw.url.indexOf('?') + 1);
		const match = SCAN_QUERY.exec(query);
		if (!match) return reply.send([]); // readiness probe hits the bare path
		const { rows } = await prepared('scan_records', SCAN_SQL, [match[1], Number(match[2])]);
		return reply.send(rows);
	});

	// The dependent-read routes need each record's contents, so a Redis hit is parsed here
	// (the read route returns the cached bytes as is); misses fill the cache like the read route.
	async function fetchRecord(id) {
		if (redis) {
			const cached = await redis.get(id);
			if (cached) return JSON.parse(cached);
		}
		const { rows } = await prepared('select_record', SELECT_SQL, [id]);
		if (rows.length === 0) return undefined;
		if (redis) await redis.set(id, JSON.stringify(rows[0]));
		return rows[0];
	}
	const callerOf = (request) => (JWT_SECRET ? request.user.sub : request.headers['x-caller']);

	app.get('/inspect/:id', async (request, reply) => {
		const record = await fetchRecord(request.params.id);
		if (!record) return reply.code(404).send({ error: 'not found' });
		const { status, body } = inspectRecord(record, callerOf(request));
		return reply.code(status).send(body);
	});

	app.get('/chain/:id', async (request, reply) => {
		const hops = parseHops(request.query.hops);
		if (hops === undefined) return reply.code(400).send({ error: 'hops must be an integer in [0, 8]' });
		const { status, body } = await chainRecords(fetchRecord, request.params.id, hops);
		return reply.code(status).send(body);
	});

	await app.listen({ port: PORT, host: '127.0.0.1', reusePort: true });
}

if (cluster.isPrimary) {
	await createSchema();
	const count = Math.min(WORKERS, availableParallelism());
	for (let i = 0; i < count; i++) cluster.fork();
	let ready = 0;
	cluster.on('message', (_worker, message) => {
		if (message === 'ready' && ++ready === count) process.stdout.write('PG_APP_READY\n');
	});
	cluster.on('exit', (worker, code) => {
		if (code !== 0) {
			process.stderr.write(`worker ${worker.process.pid} exited with ${code}\n`);
			process.exit(1);
		}
	});
} else {
	await startWorker();
	process.send('ready');
}
