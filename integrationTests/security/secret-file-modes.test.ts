/**
 * harper#1925: install into a root that already exists at 0o755 (as the official image's ROOTPATH does) under
 * umask 002, and every file Harper writes that can hold a secret must still come out owner-only — across
 * install, set_configuration with its backup, and a restart that rewrites the env-config state.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const SECRET_FILES = [
	'keys/.jwtPass',
	'keys/.jwtPrivate.key',
	'keys/privateKey.pem',
	'backup/.harper-config-state.json',
];

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

function configPath(ctx: ContextWithHarper): string {
	const harperConfig = join(ctx.harper.dataRootDir, 'harper-config.yaml');
	return existsSync(harperConfig) ? harperConfig : join(ctx.harper.dataRootDir, 'harperdb-config.yaml');
}

function assertOwnerOnly(ctx: ContextWithHarper, relativePaths: string[]) {
	for (const relativePath of relativePaths) {
		const mode = modeOf(join(ctx.harper.dataRootDir, relativePath));
		assert.strictEqual(mode & 0o077, 0, `${relativePath} is ${mode.toString(8)}, readable beyond its owner`);
	}
}

suite(
	'secret files are owner-only in a pre-existing permissive root',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let savedUmask: number;
		// An env-config value to change across the restart, so the state file is rewritten.
		const options = (aggregatePeriod: number) => ({ config: { analytics: { aggregatePeriod } } });

		before(async () => {
			savedUmask = process.umask(0o002);
			const dataRootDir = mkdtempSync(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
			);
			chmodSync(dataRootDir, 0o755);
			ctx.harper = { dataRootDir } as any;
			await startHarper(ctx, options(60));
		});

		after(async () => {
			try {
				if (ctx.harper?.process) await teardownHarper(ctx);
			} finally {
				if (savedUmask !== undefined) process.umask(savedUmask);
			}
		});

		test('install leaves the root as it found it and writes the config and keys owner-only', () => {
			assert.strictEqual(modeOf(ctx.harper.dataRootDir), 0o755, 'Harper does not chmod a root it did not create');
			assert.strictEqual(modeOf(configPath(ctx)) & 0o077, 0);
			assertOwnerOnly(ctx, SECRET_FILES);
		});

		test('the generated JWT signing key is usable', async () => {
			const { operation_token } = await sendOperation(ctx.harper, {
				operation: 'create_authentication_tokens',
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
			});
			assert.ok(operation_token, 'expected an operation_token');
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${operation_token}` },
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			assert.strictEqual(response.status, 200, await response.text());
		});

		test('set_configuration keeps the config owner-only and backs it up owner-only', async () => {
			const backupDir = join(ctx.harper.dataRootDir, 'backup');
			const backupsBefore = new Set(readdirSync(backupDir));
			await sendOperation(ctx.harper, { operation: 'set_configuration', logging_level: 'error' });
			assert.strictEqual(modeOf(configPath(ctx)) & 0o077, 0);
			const backups = readdirSync(backupDir).filter((name) => name.endsWith('.bak') && !backupsBefore.has(name));
			assert.strictEqual(backups.length, 1, `expected one new backup, found ${backups}`);
			assertOwnerOnly(ctx, [join('backup', backups[0])]);
		});

		test('a restart with changed env config rewrites the state file owner-only', async () => {
			const statePath = join(ctx.harper.dataRootDir, 'backup/.harper-config-state.json');
			const before = statSync(statePath).mtimeMs;
			await killHarper(ctx);
			await startHarper(ctx, options(61));
			assert.notStrictEqual(statSync(statePath).mtimeMs, before, 'the state file was rewritten');
			assert.strictEqual(modeOf(configPath(ctx)) & 0o077, 0);
			assertOwnerOnly(ctx, SECRET_FILES);
		});
	}
);
