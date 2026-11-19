const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function makeContext() {
	return { user: { username: 'admin', role: { permission: { super_user: true } } } };
}

const refusedAsNotHeld = (err) => err?.statusCode === 409;

// harper#4053: a lapsed hold handle keeps refusing writes to its key until unlock() or a re-lock of that key
describe('A lapsed hold lock keeps refusing writes through other instances', function () {
	let Fenced;
	let nextId = 1;
	const holders = [];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Fenced = table({
			table: 'LapsedHandleFence',
			database: 'lapsed_handle_fence',
			audit: true,
			replicate: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'n', type: 'Int' },
			],
		});
	});

	afterEach(async () => {
		while (holders.length) {
			try {
				await holders.pop().unlock();
			} catch {}
		}
	});

	after(async () => {
		await resetDatabases();
	});

	function handleOf(ctx, key) {
		return Fenced._txnForContext(ctx).recordLocks?.get(Fenced.primaryStore)?.get(key);
	}

	async function lapsedHold(ctx, key) {
		const holder = await Fenced.lock(key, { hold: true, lease: 10000 }, ctx);
		holders.push(holder);
		handleOf(ctx, key).revokeLease();
		return holder;
	}

	const kinds = {
		// no transaction(): every write commits on its own
		async immediate(body) {
			const ctx = makeContext();
			await body(ctx, async (other) => {
				await new Fenced(other, ctx).put(other, { id: other, n: 2 });
			});
		},
		// inside transaction(): a mid-scope commit is what makes the unrelated write commit
		async explicit(body) {
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				await body(ctx, async (other) => {
					await new Fenced(other, ctx).put(other, { id: other, n: 2 });
					await txn.commit();
				});
			});
		},
	};

	for (const [kind, run] of Object.entries(kinds)) {
		for (const unrelatedFirst of [false, true]) {
			it(`${kind}: refuses the stale write ${unrelatedFirst ? 'after' : 'before'} an unrelated write commits, until unlock()`, async function () {
				if (isLMDB) return this.skip();
				const key = `fence-${nextId++}`;
				const other = `${key}-other`;
				await Fenced.put(key, { id: key, n: 1 });
				let holder;
				await run(async (ctx, commitUnrelated) => {
					holder = await lapsedHold(ctx, key);
					if (unrelatedFirst) await commitUnrelated(other);
					await assert.rejects(
						async () => await new Fenced(key, ctx).put(key, { id: key, n: 999 }),
						refusedAsNotHeld,
						'the stale write through another instance is refused'
					);
					if (!unrelatedFirst) await commitUnrelated(other);
					await assert.rejects(
						async () => await new Fenced(key, ctx).put(key, { id: key, n: 998 }),
						refusedAsNotHeld,
						'a retry after the refusal and an unrelated commit is refused too'
					);
					assert.equal(await holder.unlock(), false, 'the lapsed lease already gave the native key back');
					assert.equal(handleOf(ctx, key), undefined, 'unlock() removed the lapsed handle');
					assert.equal(Fenced._txnForContext(ctx).recordLocks, undefined, 'and the emptied registry with it');
					await new Fenced(key, ctx).put(key, { id: key, n: 3 });
				});
				assert.equal((await Fenced.get(key))?.n, 3, 'a write after unlock() lands');
			});
		}

		it(`${kind}: a re-lock of the key replaces the lapsed handle`, async function () {
			if (isLMDB) return this.skip();
			const key = `fence-${nextId++}`;
			await Fenced.put(key, { id: key, n: 1 });
			await run(async (ctx, commitUnrelated) => {
				const lapsed = await lapsedHold(ctx, key);
				await commitUnrelated(`${key}-other`);
				const relocked = await Fenced.lock(key, { hold: true, lease: 10000 }, ctx);
				holders.push(relocked);
				assert.notStrictEqual(handleOf(ctx, key), undefined);
				assert.equal(handleOf(ctx, key).isExpired(), false, 'the registry holds the live handle');
				await new Fenced(key, ctx).put(key, { id: key, n: 4 });
				await assert.rejects(
					async () => {
						lapsed.set('n', 997);
						await lapsed.save();
					},
					refusedAsNotHeld,
					'the lapsed instance still cannot write through its own handle'
				);
				const live = handleOf(ctx, key);
				assert.equal(await lapsed.unlock(), false);
				assert.strictEqual(handleOf(ctx, key), live, "unlocking the lapsed instance leaves the re-lock's handle");
				await new Fenced(key, ctx).put(key, { id: key, n: 5 });
			});
			assert.equal((await Fenced.get(key))?.n, 5);
		});
	}
});
