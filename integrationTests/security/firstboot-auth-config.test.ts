/**
 * Authentication settings are honoured on the first boot, the one that installs a fresh root.
 *
 * `harper run` on an empty root loads the user and token modules before install() writes the config, so a
 * setting those modules captured at load stayed at its default for the whole first boot: the install-time
 * admin and every add_user/alter_user were stored with sha256 while argon2id was configured, and tokens
 * were minted with the default lifetimes. The admin row kept its sha256 hash across restarts.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual as equal } from 'node:assert';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const OPERATION_TOKEN_SECONDS = 7 * 60;
const REFRESH_TOKEN_SECONDS = 11 * 60;
const CONFIG = {
	authentication: { hashFunction: 'argon2id', operationTokenTimeout: '7m', refreshTokenTimeout: '11m' },
};

function tokenLifetimeSeconds(token: string): number {
	const { iat, exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
	return exp - iat;
}

async function storedHashFunction(ctx: ContextWithHarper, username: string): Promise<string> {
	const [record] = await sendOperation(ctx.harper, {
		operation: 'search_by_value',
		database: 'system',
		table: 'hdb_user',
		search_attribute: 'username',
		search_value: username,
		get_attributes: ['username', 'hash_function'],
	});
	return record?.hash_function;
}

async function createTokens(ctx: ContextWithHarper, username: string, password: string) {
	return sendOperation(ctx.harper, { operation: 'create_authentication_tokens', username, password });
}

suite('authentication config on the first boot', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: CONFIG });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the install-time admin is stored with the configured hash function', async () => {
		equal(await storedHashFunction(ctx, ctx.harper.admin.username), 'argon2id');
	});

	test('add_user and alter_user store the configured hash function', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_user',
			role: 'super_user',
			username: 'firstboot_added',
			password: 'first-pass',
			active: true,
		});
		equal(await storedHashFunction(ctx, 'firstboot_added'), 'argon2id');
		await sendOperation(ctx.harper, { operation: 'alter_user', username: 'firstboot_added', password: 'second-pass' });
		equal(await storedHashFunction(ctx, 'firstboot_added'), 'argon2id');
		await createTokens(ctx, 'firstboot_added', 'second-pass');
	});

	test('tokens are minted with the configured lifetimes, and the refresh token refreshes', async () => {
		const { operation_token, refresh_token } = await createTokens(
			ctx,
			ctx.harper.admin.username,
			ctx.harper.admin.password
		);
		equal(tokenLifetimeSeconds(operation_token), OPERATION_TOKEN_SECONDS);
		equal(tokenLifetimeSeconds(refresh_token), REFRESH_TOKEN_SECONDS);
		const refreshed = await sendOperation(ctx.harper, { operation: 'refresh_operation_token', refresh_token });
		equal(tokenLifetimeSeconds(refreshed.operation_token), OPERATION_TOKEN_SECONDS);
		const scoped = await sendOperation(ctx.harper, {
			operation: 'create_authentication_tokens',
			username: 'firstboot_scoped',
			role: { permission: { operations: ['read_only'] } },
		});
		equal(tokenLifetimeSeconds(scoped.operation_token), OPERATION_TOKEN_SECONDS);
	});

	suite('after a restart', () => {
		before(async () => {
			await killHarper(ctx);
			await startHarper(ctx, { config: CONFIG });
		});

		test('the admin and the first-boot user keep the configured hash function and still authenticate', async () => {
			equal(await storedHashFunction(ctx, ctx.harper.admin.username), 'argon2id');
			equal(await storedHashFunction(ctx, 'firstboot_added'), 'argon2id');
			await createTokens(ctx, ctx.harper.admin.username, ctx.harper.admin.password);
			await createTokens(ctx, 'firstboot_added', 'second-pass');
		});

		test('add_user stores the configured hash function', async () => {
			await sendOperation(ctx.harper, {
				operation: 'add_user',
				role: 'super_user',
				username: 'restart_added',
				password: 'restart-pass',
				active: true,
			});
			equal(await storedHashFunction(ctx, 'restart_added'), 'argon2id');
		});
	});
});
