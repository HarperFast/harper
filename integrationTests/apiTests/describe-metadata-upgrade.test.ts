/**
 * Two-phase: install a component with `@table(eviction: 300)`, capture describe_all,
 * stop, reboot on the same data dir, assert describe_all still reflects schema_defined: true
 * and expiration: "0s". Runs with threads.count: 2 so the operations-API worker that
 * answers describe is distinct from the http worker that runs the schema parser, matching
 * the cluster topology that hid the bug.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	releaseLoopbackAddress,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from './utils/client.mjs';
// @ts-expect-error utils/components.mjs has no type declarations
import { installAppComponent } from './utils/components.mjs';

const SCHEMA = `
type PageCache @table(database: "seo", eviction: 300) @export(name: "SeoPageCache") {
	cacheKey: ID! @primaryKey
	htmlContent: String
	updatedTimestamp: Long
}

type LifecycleMeta @table(database: "metadata") @export(name: "LifecycleMeta") {
	id: ID! @primaryKey
	value: String
}
`;

const CONFIG = `rest: true
graphqlSchema:
  files: '*.graphql'
`;

const PINNED_DATA_DIR = mkdtempSync(join(tmpdir(), 'describe-metadata-upgrade-'));

async function describeAll(client: ReturnType<typeof createApiClient>) {
	const res = await client.req().send({ operation: 'describe_all' });
	strictEqual(res.status, 200, 'describe_all should return 200');
	return res.body;
}

suite('describe_all metadata upgrade phase 1: install component on first boot', (ctx: ContextWithHarper) => {
	before(async () => {
		ctx.harper = { dataRootDir: PINNED_DATA_DIR } as any;
		await startHarper(ctx, { config: { threads: { count: 2 } }, env: {} } as any);
	});

	after(async () => {
		await killHarper(ctx);
		await releaseLoopbackAddress(ctx.harper.hostname);
	});

	test('install component and capture first describe_all', async () => {
		const client = createApiClient(ctx.harper);
		await installAppComponent(client, {
			project: 'describemetadataupgrade',
			files: { 'schema.graphql': SCHEMA, 'config.yaml': CONFIG },
			probePath: '/SeoPageCache/',
			restartTimeoutMs: 120_000,
		});
		// Create a dynamic table via the operations API (no attributes → schema_defined: false).
		// Asserting this stays false through the reboot guards against the existing-Table branch
		// flipping it to true via the schemaDefined default when omitting callers re-enter table().
		await client
			.req()
			.send({ operation: 'create_table', database: 'dynamic', table: 'Loose', primary_key: 'id' })
			.expect(200);
		const body = await describeAll(client);
		const pc = body.seo?.PageCache ?? body.data?.seo?.PageCache;
		const lm = body.metadata?.LifecycleMeta ?? body.data?.metadata?.LifecycleMeta;
		const loose = body.dynamic?.Loose ?? body.data?.dynamic?.Loose;
		ok(pc, 'seo.PageCache must be in describe_all phase 1');
		ok(lm, 'metadata.LifecycleMeta must be in describe_all phase 1');
		ok(loose, 'dynamic.Loose must be in describe_all phase 1');
		strictEqual(pc.schema_defined, true, 'PageCache.schema_defined should be true phase 1');
		strictEqual(pc.expiration, '0s', 'PageCache.expiration should be "0s" phase 1');
		strictEqual(lm.schema_defined, true, 'LifecycleMeta.schema_defined should be true phase 1');
		strictEqual(loose.schema_defined, false, 'dynamic.Loose.schema_defined should be false phase 1');
	});
});

suite('describe_all metadata upgrade phase 2: reboot on same data dir, metadata must survive', (ctx: ContextWithHarper) => {
	before(async () => {
		ctx.harper = { dataRootDir: PINNED_DATA_DIR } as any;
		await startHarper(ctx, { config: { threads: { count: 2 } }, env: {} } as any);
	});

	after(async () => {
		await teardownHarper(ctx);
		try {
			rmSync(PINNED_DATA_DIR, { recursive: true, force: true });
		} catch {}
	});

	test('phase 2 describe_all preserves schema_defined and expiration across reboot', async () => {
		const client = createApiClient(ctx.harper);
		const body = await describeAll(client);
		const pc = body.seo?.PageCache ?? body.data?.seo?.PageCache;
		const lm = body.metadata?.LifecycleMeta ?? body.data?.metadata?.LifecycleMeta;
		const loose = body.dynamic?.Loose ?? body.data?.dynamic?.Loose;
		ok(pc, 'seo.PageCache must be in describe_all phase 2');
		ok(lm, 'metadata.LifecycleMeta must be in describe_all phase 2');
		ok(loose, 'dynamic.Loose must be in describe_all phase 2');
		strictEqual(pc.schema_defined, true, 'PageCache.schema_defined must remain true after restart');
		strictEqual(pc.expiration, '0s', 'PageCache.expiration must remain "0s" after restart');
		strictEqual(lm.schema_defined, true, 'LifecycleMeta.schema_defined must remain true after restart');
		strictEqual(loose.schema_defined, false, 'dynamic.Loose.schema_defined must remain false after restart');
	});
});
