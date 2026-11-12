/**
 * Promoted from qa-explorer (QA-577 / P-373): pins the in-place-upgrade built-in-component
 * config backfill (regression anchor for merged PR #1814 and harper#2028) — booting over a config lacking a
 * now-built-in component backfills exactly one top-level key with an activation log; a second
 * boot is idempotent; a fresh install with the key already present is a no-op; OSS-core never
 * grows the Pro-only key.
 *
 * QA-577 — exploratory probe of PR #1814 "fix(upgrade): activate new built-in
 * components on in-place-upgraded configs" (branch kris/secretcustody-upgrade-config-585).
 *
 * The fix (config/configUtils.ts: ensureConfigKeysPresent / ensureBuiltInComponentConfigKeys,
 * called every boot from bin/run.ts initialize()) backfills a top-level config key for a
 * newly-introduced built-in component (currently only `secretCustody`, see
 * UPGRADE_BACKFILL_BUILTIN_KEYS) when it's absent, so the component activates on an
 * in-place-upgraded config that predates it. It is scoped to built-ins registered in THIS
 * runtime via the HARPER_BUILTIN_COMPONENTS env var (a comma-separated `name=packageIdentifier`
 * list an embedding distribution — e.g. harper-pro — sets before boot); on OSS core, where
 * nothing is registered, it is a no-op.
 *
 * ## Honest scope note
 * This is OSS core (github.com/HarperFast/harper). `secretCustody` is Pro-only — its real
 * package is never present here, and OSS core's own defaultConfig.yaml never defines the key.
 * So the "genuine pre-upgrade config" and "genuine fresh Pro install" states can't be produced
 * by installing real Harper builds; instead HARPER_BUILTIN_COMPONENTS is set directly to make
 * this runtime "register" `secretCustody` the same way harper-pro would, and the fresh-install
 * control directly seeds the config file with the key present (see seedConfigKey) to reproduce
 * the "already there" starting state a real defaultConfig.yaml would produce. The config-file
 * backfill mechanism itself (the actual PR diff) is exercised for real; only the "which process
 * sets HARPER_BUILTIN_COMPONENTS" wiring, and how the key first got into a fresh install's
 * config, are simulated.
 *
 * Axes probed (not the PR's own test plan, which only checks a single upgrade+restart):
 *   1. G-axis: a config that lacks the built-in's key gets it backfilled + activation logged,
 *      AND a second boot over the SAME data dir does not re-log/duplicate it (idempotence).
 *   2. Fresh-install control: a config seeded with the key already present (as a real Pro
 *      defaultConfig.yaml would provide) is untouched — no log, no duplicate.
 *   3. OSS-core control: no HARPER_BUILTIN_COMPONENTS registered (the real OSS core boot
 *      path) never writes the Pro-only key.
 *   4. Incomplete registration: a bare `waf` entry is warned and skipped by both runtime
 *      loading and config backfill.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/qa577-upgrade-builtins.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import YAML from 'yaml';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa577-upgrade-builtins');

// Matches UPGRADE_BACKFILL_BUILTIN_KEYS in config/configUtils.ts — one of two backfilled keys today.
const BACKFILL_KEY = 'secretCustody';
const ACTIVATION_LOG_SNIPPET = 'Activated built-in component(s) absent from an upgraded config';
const MALFORMED_BACKFILL_REGISTRATION = 'waf';
const MALFORMED_REGISTRATION_WARNING = 'Skipping HARPER_BUILTIN_COMPONENTS entry 2';
const ROOT_APPLICATIONS_LOADED_SNIPPET = 'All root applications loaded';

// The valid registration uses a real, side-effect-free internal module. `Application.ts` skips
// `@/` identifiers for package installation, while component loading can resolve the module.
const BACKFILL_KEY_REGISTRATION = `${BACKFILL_KEY}=@/dist/utility/common_utils.js`;
const UPGRADE_REGISTRATIONS = `${BACKFILL_KEY_REGISTRATION},${MALFORMED_BACKFILL_REGISTRATION}`;

const skip = process.platform === 'win32';

function readConfigFile(dataRootDir: string): { path: string; doc: any; raw: string } {
	for (const name of ['harper-config.yaml', 'harperdb-config.yaml']) {
		const p = join(dataRootDir, name);
		if (existsSync(p)) {
			const raw = readFileSync(p, 'utf8');
			return { path: p, doc: YAML.parse(raw), raw };
		}
	}
	throw new Error(`No harper-config.yaml/harperdb-config.yaml found under ${dataRootDir}`);
}

/** Counts occurrences of `key:` anchored at column 0 — i.e. as a top-level YAML key, not nested. */
function countTopLevelKey(raw: string, key: string): number {
	return (raw.match(new RegExp(`^${key}:`, 'gm')) || []).length;
}

/**
 * Directly seeds `key: {}` into the on-disk config file, bypassing the backfill mechanism under
 * test — used to emulate "this key was already here" (e.g. a real Pro defaultConfig.yaml entry at
 * a genuine fresh install) as a precondition, not as an assertion.
 *
 * Note: HARPER_SET_CONFIG can't do this seeding — it was tried first and doesn't work for this
 * shape. harperConfigEnvVars.ts's env-var merge operates on FLATTENED leaf paths
 * (flattenObject/setNestedValue), and flattening an empty object (`{secretCustody: {}}`) yields
 * zero leaf entries — there is no scalar to set a path to — so the container key itself is never
 * written. `HARPER_SET_CONFIG={"secretCustody":{}}` silently no-ops. That's expected given the
 * env-var layer's leaf-value contract; direct file seeding is the correct way to precondition an
 * empty-block top-level key, so this isn't a defect in the layer, just a tool-choice correction.
 */
function seedConfigKey(dataRootDir: string, key: string): void {
	const { path, raw } = readConfigFile(dataRootDir);
	const doc = YAML.parseDocument(raw);
	doc.setIn([key], {});
	writeFileSync(path, String(doc));
}

/**
 * The activation log line (`hdbLogger.info(...)`) is written through the structured logger, which
 * the test harness routes to hdb.log, NOT the raw process stdout captured in `startupOutput.stdout`
 * — the harness boots with `--LOGGING_STDSTREAMS=false`, so only bare `console.log` banner/status
 * lines (ASCII art, "Harper successfully started") reach `startupOutput.stdout`, never this line.
 *
 * `harper.logDir` is only set when HARPER_INTEGRATION_TEST_LOG_DIR is configured (a per-boot
 * directory, fresh on every startHarper() call); otherwise Harper falls back to its own default
 * (validation/configValidator.ts's DEFAULT_LOG_FOLDER = 'log', resolved against rootPath) — i.e.
 * `${dataRootDir}/log/hdb.log`, since this harness passes `--ROOTPATH=${dataRootDir}`.
 */
function bootLogPath(harper: { logDir?: string; dataRootDir: string }): string {
	return harper.logDir ? join(harper.logDir, 'hdb.log') : join(harper.dataRootDir, 'log', 'hdb.log');
}

function readBootLog(harper: { logDir?: string; dataRootDir: string }): string {
	const logPath = bootLogPath(harper);
	return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

/**
 * Poll a probe route until it stops 404-ing. `/Marker/` is defined in the fixture's
 * schema.graphql and loaded at boot, so no `restart_service http_workers` is needed here —
 * just wait out the boot race between the process being reachable and REST routes registering.
 */
async function waitForRouteReady(
	client: ReturnType<typeof createApiClient>,
	probePath: string,
	timeoutMs = 60_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await client.reqRest(probePath).timeout(2000);
			if (response.status !== 404) return;
		} catch {
			/* not ready yet */
		}
		await sleep(250);
	}
	throw new Error(`Probe ${probePath} did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Suite 1: G-axis activation + same-dir second-boot idempotence
// ---------------------------------------------------------------------------

suite(
	'QA-577: upgraded config (built-in key absent) gets backfilled and activated',
	{ skip },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {},
				env: { HARPER_BUILTIN_COMPONENTS: UPGRADE_REGISTRATIONS },
			});
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('first boot: key backfilled into config, exactly once, activation logged', async () => {
			const client = createApiClient(ctx.harper);
			await waitForRouteReady(client, '/Marker/');

			const { doc, raw } = readConfigFile(ctx.harper.dataRootDir);
			ok(
				Object.prototype.hasOwnProperty.call(doc, BACKFILL_KEY),
				`expected ${BACKFILL_KEY} key to be backfilled into config; config keys were: ${Object.keys(doc)}`
			);
			strictEqual(countTopLevelKey(raw, BACKFILL_KEY), 1, `expected exactly one top-level ${BACKFILL_KEY} key`);
			ok(
				!Object.prototype.hasOwnProperty.call(doc, MALFORMED_BACKFILL_REGISTRATION),
				`incomplete ${MALFORMED_BACKFILL_REGISTRATION} registration must not backfill a config key`
			);
			const bootLog = readBootLog(ctx.harper);
			ok(
				bootLog.includes(ACTIVATION_LOG_SNIPPET),
				`expected activation log on first boot (key was absent); hdb.log:\n${bootLog}`
			);
			ok(
				bootLog.includes(MALFORMED_REGISTRATION_WARNING),
				`expected a warning for the incomplete registration; hdb.log:\n${bootLog}`
			);
			ok(
				bootLog.includes(ROOT_APPLICATIONS_LOADED_SNIPPET),
				`expected root application installation to complete; hdb.log:\n${bootLog}`
			);
		});

		test('second boot over same data dir: no re-activation log, no duplicate key, boots clean', async () => {
			// hdb.log is append-only and (absent HARPER_INTEGRATION_TEST_LOG_DIR) lives at a fixed
			// path under the unchanged dataRootDir, so it still carries the FIRST boot's activation
			// line going into this restart. Snapshot where it was before restarting and diff only the
			// bytes appended after, or the first boot's line would make this assertion fail even when
			// the second boot correctly did NOT re-log.
			const priorLogPath = bootLogPath(ctx.harper);
			const priorLogLen = readBootLog(ctx.harper).length;

			await killHarper(ctx);
			await startHarper(ctx, {
				config: {},
				env: { HARPER_BUILTIN_COMPONENTS: UPGRADE_REGISTRATIONS },
			});

			const client = createApiClient(ctx.harper);
			await waitForRouteReady(client, '/Marker/');

			const { doc, raw } = readConfigFile(ctx.harper.dataRootDir);
			ok(
				Object.prototype.hasOwnProperty.call(doc, BACKFILL_KEY),
				`${BACKFILL_KEY} key must still be present after 2nd boot`
			);
			ok(
				!Object.prototype.hasOwnProperty.call(doc, MALFORMED_BACKFILL_REGISTRATION),
				`incomplete ${MALFORMED_BACKFILL_REGISTRATION} registration must not backfill a config key`
			);
			strictEqual(
				countTopLevelKey(raw, BACKFILL_KEY),
				1,
				`expected still exactly one top-level ${BACKFILL_KEY} key (no duplication)`
			);
			const fullLog = readBootLog(ctx.harper);
			// If HARPER_INTEGRATION_TEST_LOG_DIR is set, this boot got a fresh logDir (a distinct
			// file), so there's nothing to diff against — take the whole thing.
			const bootLog = bootLogPath(ctx.harper) === priorLogPath ? fullLog.slice(priorLogLen) : fullLog;
			ok(
				!bootLog.includes(ACTIVATION_LOG_SNIPPET),
				`expected NO activation log appended by the 2nd boot (key already present, must be idempotent); appended log:\n${bootLog}`
			);
		});
	}
);

// ---------------------------------------------------------------------------
// Suite 2: fresh-install control — key already present (as a real Pro defaultConfig.yaml would
// bake in at install time), backfill must be a true no-op.
// ---------------------------------------------------------------------------

suite('QA-577: fresh-install control (built-in key already present)', { skip }, (ctx: ContextWithHarper) => {
	after(async () => {
		await teardownHarper(ctx);
	});

	test('key already present at boot: no activation log, no duplicate', async () => {
		// Step 1: plain install/boot (no HARPER_BUILTIN_COMPONENTS) — produces an ordinary config
		// file with no secretCustody key, same as any OSS-core boot. Pin the var to '' rather than
		// just omitting it from `env`: the harness spawns with `{ ...process.env, ...env }`, so an
		// AMBIENT HARPER_BUILTIN_COMPONENTS (e.g. this suite running inside harper-pro's own CI,
		// which sets it for the embedded core checkout) would otherwise flow straight through.
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { HARPER_BUILTIN_COMPONENTS: '' } });
		await killHarper(ctx);

		// Step 2: seed the key directly (emulating "a real defaultConfig.yaml already provided
		// this" precondition — see seedConfigKey's doc comment for why HARPER_SET_CONFIG can't
		// do this), then boot with the built-in registered. The key is present before this boot
		// even starts, so the backfill must see it and no-op.
		seedConfigKey(ctx.harper.dataRootDir, BACKFILL_KEY);
		await startHarper(ctx, {
			config: { logging: { level: 'info' } },
			env: { HARPER_BUILTIN_COMPONENTS: BACKFILL_KEY_REGISTRATION },
		});

		const client = createApiClient(ctx.harper);
		await waitForRouteReady(client, '/Marker/');

		const { doc, raw } = readConfigFile(ctx.harper.dataRootDir);
		ok(Object.prototype.hasOwnProperty.call(doc, BACKFILL_KEY));
		strictEqual(countTopLevelKey(raw, BACKFILL_KEY), 1, 'must not duplicate the key');
		const bootLog = readBootLog(ctx.harper);
		// Positive control (as qa702 does): prove hdb.log actually captured real boot content
		// before trusting its ABSENCE below — otherwise a missing/misrouted log file would make
		// the negative assertion pass vacuously regardless of what the backfill did. The explicit
		// `logging.level: 'info'` above isn't what makes content appear here (the integration
		// harness already forces `--LOGGING_LEVEL=debug`, which is a superset); it's pinned so
		// this suite doesn't depend on that harness default remaining as verbose as it is today.
		ok(
			bootLog.length > 0,
			`positive control: expected hdb.log to have real boot content at ${bootLogPath(ctx.harper)} -- ` +
				`if this is empty, the activation-log assertion below can't detect anything, regardless of what it shows`
		);
		ok(
			!bootLog.includes(ACTIVATION_LOG_SNIPPET),
			`key already present at boot must not log a backfill activation; hdb.log:\n${bootLog}`
		);
	});
});

// ---------------------------------------------------------------------------
// Suite 3: OSS-core control — nothing registered, Pro-only key must never appear.
// ---------------------------------------------------------------------------

suite('QA-577: OSS-core control (no HARPER_BUILTIN_COMPONENTS registered)', { skip }, (ctx: ContextWithHarper) => {
	after(async () => {
		await teardownHarper(ctx);
	});

	test('real OSS core boot path never backfills the Pro-only key', async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { logging: { level: 'info' } },
			// Pin '' rather than omitting the key: the harness spawns with `{ ...process.env, ...env }`,
			// so an ambient HARPER_BUILTIN_COMPONENTS (e.g. this suite run under harper-pro's own CI)
			// would otherwise flow straight through and register a built-in this control asserts is not.
			env: { HARPER_BUILTIN_COMPONENTS: '' },
		});

		const client = createApiClient(ctx.harper);
		await waitForRouteReady(client, '/Marker/');

		const { doc } = readConfigFile(ctx.harper.dataRootDir);
		ok(
			!Object.prototype.hasOwnProperty.call(doc, BACKFILL_KEY),
			`OSS core with no built-ins registered must not get ${BACKFILL_KEY} backfilled; config keys were: ${Object.keys(doc)}`
		);
		const bootLog = readBootLog(ctx.harper);
		// Positive control (as qa702 does): prove hdb.log actually captured real boot content
		// before trusting its ABSENCE below — otherwise an empty/missing hdb.log (path drift,
		// log never created) would make the negative assertion pass vacuously. The explicit
		// `logging.level: 'info'` above isn't what makes content appear here (the integration
		// harness already forces `--LOGGING_LEVEL=debug`, which is a superset); it's pinned so
		// this suite doesn't depend on that harness default remaining as verbose as it is today.
		ok(
			bootLog.length > 0,
			`positive control: expected hdb.log to have real boot content at ${bootLogPath(ctx.harper)} -- ` +
				`if this is empty, the activation-log assertion below can't detect anything, regardless of what it shows`
		);
		ok(!bootLog.includes(ACTIVATION_LOG_SNIPPET));
	});
});
