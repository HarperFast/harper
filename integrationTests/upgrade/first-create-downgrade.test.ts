/**
 * Tables first created after a minor upgrade remain readable and writable by 5.2,
 * including secondary indexes and writes carried through a re-upgrade (#3102).
 */
import { suite, test, after } from 'node:test';
import assert from 'node:assert';
import { delimiter, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const previousPath = process.env.HARPER_PREVIOUS_MINOR_PATH?.split(delimiter).find((path) => {
	const { version } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
	return version.startsWith('5.2.');
});

suite(
	'first-time table create survives 5.2 rollback',
	{
		skip:
			!previousPath ||
			process.env.HARPER_RUNTIME === 'bun' ||
			process.env.HARPER_STORAGE_ENGINE === 'lmdb' ||
			process.platform === 'win32',
		timeout: 300_000,
	},
	(ctx: ContextWithHarper) => {
		after(async () => teardownHarper(ctx));

		test('preserves primary rows, secondary indexes and rollback writes', async () => {
			const previousBin = join(previousPath!, 'dist', 'bin', 'harper.js');
			await startHarper(ctx, { config: {}, env: { TC_AGREEMENT: 'yes' }, harperBinPath: previousBin });
			await killHarper(ctx);
			await startHarper(ctx, { config: {} });
			const schemas = [undefined, 'new_on_current'];
			await sendOperation(ctx.harper, { operation: 'create_schema', schema: 'new_on_current' });
			const records = [
				{ id: 'a', category: 'current' },
				{ id: 'b', category: 'current' },
			];
			for (const schema of schemas) {
				await sendOperation(ctx.harper, {
					operation: 'create_table',
					schema,
					table: 'born_on_current',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'category', type: 'String', indexed: true },
					],
				});
				await sendOperation(ctx.harper, { operation: 'upsert', schema, table: 'born_on_current', records });
			}
			await sendOperation(ctx.harper, { operation: 'create_table', table: 'recreated', primary_key: 'id' });
			await sendOperation(ctx.harper, { operation: 'upsert', table: 'recreated', records: [{ id: 'retired' }] });
			await sendOperation(ctx.harper, { operation: 'drop_table', table: 'recreated' });
			await sendOperation(ctx.harper, { operation: 'create_table', table: 'recreated', primary_key: 'id' });
			await sendOperation(ctx.harper, { operation: 'upsert', table: 'recreated', records: [{ id: 'stamped' }] });
			await sendOperation(ctx.harper, { operation: 'create_table', table: 'rollback_recreate', primary_key: 'id' });
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'rollback_recreate',
				records: [{ id: 'retired' }],
			});
			await sendOperation(ctx.harper, { operation: 'drop_table', table: 'rollback_recreate' });
			await killHarper(ctx);
			await startHarper(ctx, { config: {}, env: { CONFIRM_DOWNGRADE: 'yes' }, harperBinPath: previousBin });
			await sendOperation(ctx.harper, { operation: 'create_table', table: 'rollback_recreate', primary_key: 'id' });
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'rollback_recreate',
				records: [{ id: 'legacy-recreated' }],
			});

			const read = (schema: string | undefined, attribute = 'id', value = '*') =>
				sendOperation(ctx.harper, {
					operation: 'search_by_value',
					schema,
					table: 'born_on_current',
					search_attribute: attribute,
					search_value: value,
					get_attributes: ['id', 'category'],
				});
			assert.deepStrictEqual(
				await sendOperation(ctx.harper, {
					operation: 'search_by_value',
					table: 'recreated',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				}),
				[],
				'5.2 does not support generation-stamped recreates'
			);
			const rollbackRecord = { id: 'c', category: 'rollback' };
			for (const schema of schemas) {
				assert.deepStrictEqual(await read(schema), records);
				assert.deepStrictEqual(await read(schema, 'category', 'current'), records);
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					schema,
					table: 'born_on_current',
					records: [rollbackRecord],
				});
			}
			await killHarper(ctx);
			await startHarper(ctx, { config: {} });
			assert.deepStrictEqual(
				await sendOperation(ctx.harper, {
					operation: 'search_by_value',
					table: 'rollback_recreate',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id'],
				}),
				[{ id: 'legacy-recreated' }],
				'a retired journal must not reclaim the bare table recreated on 5.2'
			);
			for (const schema of schemas) {
				assert.deepStrictEqual(await read(schema), [...records, rollbackRecord]);
				assert.deepStrictEqual(await read(schema, 'category', 'current'), records);
				assert.deepStrictEqual(await read(schema, 'category', 'rollback'), [rollbackRecord]);
			}
		});
	}
);
