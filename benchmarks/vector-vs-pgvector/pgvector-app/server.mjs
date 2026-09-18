/**
 * Fastify + pgvector k-NN endpoint, mirroring Harper's REST surface.
 *
 * Port 9941 to stay clear of the integration-test framework's conflict-probe ports.
 */
import Fastify from 'fastify';
import cluster from 'node:cluster';
import pg from 'pg';

const PORT = 9941;
const WORKERS = Number(process.env.VEC_WORKERS || 6);
const POOL_SIZE = Number(process.env.VEC_POOL_SIZE || 24);
const PG_URL = 'postgres://vec:vec@127.0.0.1:5434/vec';
// Per-connection ef_search: pgvector reads it at plan time, so it must be set on the session
// each connection uses, not once globally.
const EF_SEARCH = Number(process.env.VEC_EF_SEARCH || 40);

if (cluster.isPrimary) {
	for (let i = 0; i < WORKERS; i++) cluster.fork();
	// Deliberately no refork-on-exit. In a benchmark a worker that cannot start is a result, not
	// something to paper over: reforking turned a port still held by a previous run into an
	// unbounded EADDRINUSE loop that ran the measurement to completion against a dead server.
	cluster.on('exit', (worker, code, signal) => {
		console.error(`pgvector-app worker ${worker.process.pid} exited (code ${code}, signal ${signal})`);
		process.exit(1);
	});
} else {
	const pool = new pg.Pool({
		connectionString: PG_URL,
		max: POOL_SIZE,
		// Every pooled connection needs ef_search applied before it serves a query.
		options: `-c hnsw.ef_search=${EF_SEARCH}`,
	});
	const app = Fastify({ logger: false });

	// The ORDER BY operator must match the index's operator class or Postgres cannot use the
	// index at all: a cosine index (vector_cosine_ops) is only usable by <=>, and pairing it with
	// <-> silently falls back to a sequential scan — which looks like ~100% recall at ~2% of the
	// throughput, i.e. an exact search wearing an ANN benchmark's clothes.
	const OP = process.env.VEC_OP || '<=>';
	const SEARCH_SQL = `SELECT id FROM items ORDER BY embedding ${OP} $1 LIMIT $2`;

	app.post('/search', async (request, reply) => {
		const { vector, k } = request.body;
		const literal = `[${vector.join(',')}]`; // pgvector's literal form
		const { rows } = await pool.query(SEARCH_SQL, [literal, k]);
		return reply.send(rows.map((r) => r.id));
	});

	// Writes go through the pooled connection, not a psql subprocess. Spawning `docker compose
	// exec psql` per row costs ~330ms of process startup, which swamps whatever the index
	// actually does and would be reported as pgvector's write latency.
	app.post('/insert', async (request, reply) => {
		const { id, vector } = request.body;
		await pool.query('INSERT INTO items (id, embedding) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET embedding = $2', [
			id,
			`[${vector.join(',')}]`,
		]);
		return reply.send({ id });
	});

	app.get('/health', async (_req, reply) => {
		await pool.query('SELECT 1');
		return reply.send({ ok: true });
	});

	app.listen({ port: PORT, host: '127.0.0.1' }, (err) => {
		if (err) {
			console.error(err);
			process.exit(1);
		}
	});
}
