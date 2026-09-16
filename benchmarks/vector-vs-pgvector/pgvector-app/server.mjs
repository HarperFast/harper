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
	cluster.on('exit', () => cluster.fork());
} else {
	const pool = new pg.Pool({
		connectionString: PG_URL,
		max: POOL_SIZE,
		// Every pooled connection needs ef_search applied before it serves a query.
		options: `-c hnsw.ef_search=${EF_SEARCH}`,
	});
	const app = Fastify({ logger: false });

	app.post('/search', async (request, reply) => {
		const { vector, k } = request.body;
		// pgvector's literal form is '[1,2,3]'; the <-> operator is L2 distance and is what the
		// HNSW index is built for, so the ORDER BY must use it verbatim to hit the index.
		const literal = `[${vector.join(',')}]`;
		const { rows } = await pool.query('SELECT id FROM items ORDER BY embedding <-> $1 LIMIT $2', [literal, k]);
		return reply.send(rows.map((r) => r.id));
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
