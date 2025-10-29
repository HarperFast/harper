import { describe, it, before, after } from 'mocha';
import assert from 'node:assert/strict';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';
import { setTxnExpiration } from '@/resources/DatabaseTransaction';
import { setMainIsWorker } from '@/server/threads/manageThreads';
import { table } from '@/resources/databases';

describe('Txn Expiration', () => {
	let SlowResource;

	before(async function () {
		createTestSandbox();
		setMainIsWorker(true); // TODO: Should be default until changed
		let BasicTable = table({
			table: 'BasicTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		SlowResource = class extends BasicTable {
			async get(query) {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return super.get(query);
			}
		};
	});

	it('Slow txn will expire', async function () {
		let tracked_txns = setTxnExpiration(20);
		let result = SlowResource.get(3);
		assert.equal(tracked_txns.size, 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(tracked_txns.size, 0);
	});

	after(function () {
		setTxnExpiration(30000);
		cleanupTestSandbox();
	});
});
