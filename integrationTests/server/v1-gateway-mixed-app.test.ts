/**
 * Mixed-app regression test for the `/v1/*` gateway (#631, PR #1616 review).
 *
 * An earlier revision made componentLoader start REST on the gateway's behalf
 * whenever `modelsGateway` was enabled:
 *
 *   if (isRoot && resources.isWorker && config.modelsGateway?.enabled) {
 *     REST.ensureStarted({ server, resources });
 *   }
 *
 * Root components load before application directories, and REST serves the
 * shared `Resources` registry, so that force-start exposed every REST-exportable
 * entry — including apps that had deliberately omitted `rest`. It also set
 * `REST.started` before a later app could contribute its own port/host/urlPath/
 * WebSocket options.
 *
 * The force-start is gone; the gateway is a plain plugin that requires REST to
 * already be configured. This pins that.
 *
 * IMPORTANT — what this test can and cannot show. Once a root `rest` section
 * exists, REST serves the shared registry and an app's `@export`ed table is
 * reachable whether or not that app declared `rest` itself. That is existing
 * Harper behavior and is not what this test is about. The gateway-specific
 * regression is only observable with NO `rest` section anywhere: previously,
 * enabling the gateway alone was enough to stand REST up and expose the app.
 * So this suite deliberately configures no `rest` at all.
 *
 * Expected now: enabling the gateway starts nothing, so the app stays off the
 * wire. `/v1/*` is unserved too — that is the documented trade-off in
 * resources/models/v1/index.ts, which logs a warning rather than forcing REST.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolvePath(__dirname, 'v1-gateway-mixed-app');
const ECHO_BACKEND_PATH = resolvePath(__dirname, 'fixtures/v1-gateway-test-backend.cjs');

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

/**
 * With no REST server expected, a request may be refused outright rather than
 * answered. Both outcomes mean "not served"; only a 200 is a regression.
 */
async function statusOrRefused(ctx: ContextWithHarper, path: string): Promise<number | 'refused'> {
	try {
		const res = await fetch(`${ctx.harper.httpURL}${path}`, {
			headers: { Authorization: authHeader(ctx) },
			signal: AbortSignal.timeout(5_000),
		});
		return res.status;
	} catch {
		return 'refused';
	}
}

suite('/v1 gateway does not stand REST up on another component behalf', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				// Deliberately NO `rest` section — see the header. This is the only
				// configuration in which the gateway's own effect on REST is observable.
				modelsGateway: { enabled: true },
				models: {
					generative: { default: { backend: ECHO_BACKEND_PATH } },
					embedding: { default: { backend: ECHO_BACKEND_PATH } },
				},
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('an app that omitted `rest` is not exposed by enabling the gateway', async () => {
		const status = await statusOrRefused(ctx, '/MixedAppPrivate/');
		assert.notEqual(
			status,
			200,
			'enabling modelsGateway must not start REST, which would expose an app that ' +
				'declared no `rest` section of its own'
		);
	});

	test('the gateway does not serve itself either, rather than forcing REST', async () => {
		// The other half of the same property: the gateway declines to start REST for
		// its own benefit too. resources/models/v1/index.ts warns about exactly this.
		const status = await statusOrRefused(ctx, '/v1/models');
		assert.notEqual(status, 200, 'the gateway must not force REST to start for its own resources');
	});
});

/**
 * Control for the suite above.
 *
 * Without this, the primary assertions could pass vacuously — a typo'd path or a
 * fixture that never deployed would also "not be reachable". Here the identical
 * fixture and URL are exercised with a root `rest` section present, which is the
 * state the removed force-start effectively created. The table becomes reachable,
 * so `notEqual(status, 200)` above is a real constraint and not an artifact.
 *
 * This also documents current Harper behavior: once REST is running it serves the
 * shared `Resources` registry, so an `@export`ed table is reachable even though
 * this app declares no `rest` of its own. Whether that ought to be per-app scoped
 * is a separate question (#1931) — this test only pins that enabling the gateway
 * is not what causes it.
 */
suite('control: the same table IS reachable once REST is configured', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				// `webSocket` is a leaf value because a plain empty object is dropped by
				// flattenObject() in harperConfigEnvVars.ts.
				rest: { webSocket: true },
				modelsGateway: { enabled: true },
				models: {
					generative: { default: { backend: ECHO_BACKEND_PATH } },
					embedding: { default: { backend: ECHO_BACKEND_PATH } },
				},
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('proves the probe URL is live when REST is running', async () => {
		const status = await statusOrRefused(ctx, '/MixedAppPrivate/');
		assert.equal(status, 200, 'if this stops returning 200 the regression guard above has gone vacuous');
	});
});
