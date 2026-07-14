/**
 * hdb_secret plaintext-leak probe — harper#715 / PR#1554.
 *
 * Pins: `set_secret` (create + rotate) never surfaces plaintext via `read_audit_log`
 * (blocked 403) or via a generic system-table read (search_by_value / sql only return
 * the `enc:v1:` ciphertext envelope, never the raw value).
 *
 * Run: npm run test:integration -- "integrationTests/components/secret-audit-leak.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/secret-audit-leak');
const skipSuite = process.platform === 'win32';

const SECRET_NAME = 'qa_test_secret';
const MARKER_A = 'qa517-super-secret-plaintext-12345-AAA';
const MARKER_B = 'qa517-super-secret-plaintext-67890-BBB-rotated';

suite(
	'hdb_secret audit-log / generic-table plaintext leak probe (#715)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		const findings: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { logging: { auditLog: true } },
				env: {
					HARPER_BUILTIN_COMPONENTS:
						'qa517RegisterCustody=@/integrationTests/components/fixtures/secret-audit-leak/registerCustody.js',
				},
			});
			client = createApiClient(ctx.harper);

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const r = await client.req().send({ operation: 'get_secrets_public_key' });
				if (r.status === 200 && r.body?.fingerprint) break;
				await sleep(250);
			}
		});

		after(async () => {
			console.log('\n===== secret-audit-leak findings =====');
			for (const f of findings) console.log(f);
			console.log('======================================\n');
			await teardownHarper(ctx);
		});

		test('system.hdb_secret exists as a built-in system table', async () => {
			const r = await client.req().send({ operation: 'describe_table', database: 'system', table: 'hdb_secret' });
			equal(r.status, 200, `describe_table failed: ${JSON.stringify(r.body)}`);
			findings.push(`describe_table system.hdb_secret: ${JSON.stringify(r.body)}`);
		});

		test('set_secret encrypts on ingest; read_audit_log on system.hdb_secret is blocked with 403', async () => {
			const setResp = await client.req().send({ operation: 'set_secret', name: SECRET_NAME, value: MARKER_A });
			equal(setResp.status, 200, `set_secret failed: ${JSON.stringify(setResp.body)}`);
			ok(!JSON.stringify(setResp.body).includes(MARKER_A), 'set_secret response must not echo the plaintext');
			equal(setResp.body.created, true);
			findings.push(`set_secret(create) response: ${JSON.stringify(setResp.body)}`);

			const auditResp = await client.req().send({
				operation: 'read_audit_log',
				database: 'system',
				table: 'hdb_secret',
				search_type: 'hash_value',
				search_values: [SECRET_NAME],
			});
			findings.push(
				`read_audit_log system.hdb_secret status=${auditResp.status} body=${JSON.stringify(auditResp.body)}`
			);

			if (auditResp.status !== 403) {
				const bodyText = JSON.stringify(auditResp.body);
				ok(!bodyText.includes(MARKER_A), 'read_audit_log body must never contain the plaintext value');
			}
			equal(auditResp.status, 403, 'read_audit_log on system.hdb_secret must be blocked by design');
		});

		test('rotation (update) — read_audit_log still blocked; no intermediate plaintext observable', async () => {
			const setResp = await client.req().send({ operation: 'set_secret', name: SECRET_NAME, value: MARKER_B });
			equal(setResp.status, 200, `set_secret (rotate) failed: ${JSON.stringify(setResp.body)}`);
			equal(setResp.body.created, false, 'rotation should report created:false (update path)');
			ok(
				!JSON.stringify(setResp.body).includes(MARKER_B),
				'rotated set_secret response must not echo the new plaintext'
			);
			findings.push(`set_secret(rotate) response: ${JSON.stringify(setResp.body)}`);

			const auditResp = await client.req().send({
				operation: 'read_audit_log',
				database: 'system',
				table: 'hdb_secret',
				search_type: 'hash_value',
				search_values: [SECRET_NAME],
			});
			findings.push(`read_audit_log post-rotation status=${auditResp.status}`);

			if (auditResp.status !== 403) {
				const bodyText = JSON.stringify(auditResp.body);
				ok(
					!bodyText.includes(MARKER_B) && !bodyText.includes(MARKER_A),
					'read_audit_log body must never contain either plaintext value'
				);
			}
			equal(auditResp.status, 403, 'read_audit_log on system.hdb_secret must be blocked by design (rotation case)');
		});

		test('generic system-table read (search_by_value, sql) shows only the enc:v1: envelope, never plaintext', async () => {
			const r = await client.req().send({
				operation: 'search_by_value',
				database: 'system',
				table: 'hdb_secret',
				search_attribute: 'name',
				search_value: SECRET_NAME,
				get_attributes: ['*'],
			});
			equal(r.status, 200, `search_by_value failed: ${JSON.stringify(r.body)}`);
			equal(r.body.length, 1, 'expected exactly one row for the test secret');
			const row = r.body[0];
			findings.push(`search_by_value row: ${JSON.stringify(row)}`);

			ok(
				typeof row.envelope === 'string' && row.envelope.startsWith('enc:v1:'),
				'envelope must be the enc:v1: ciphertext form'
			);
			const rowText = JSON.stringify(row);
			ok(
				!rowText.includes(MARKER_A) && !rowText.includes(MARKER_B),
				'generic table read must never expose plaintext values'
			);

			const sqlResp = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT * FROM system.hdb_secret WHERE name = '${SECRET_NAME}'` });
			equal(sqlResp.status, 200, `sql failed: ${JSON.stringify(sqlResp.body)}`);
			const sqlText = JSON.stringify(sqlResp.body);
			findings.push(`sql SELECT * FROM system.hdb_secret: ${sqlText}`);
			ok(
				!sqlText.includes(MARKER_A) && !sqlText.includes(MARKER_B),
				'SQL generic read must never expose plaintext values'
			);
		});
	}
);
