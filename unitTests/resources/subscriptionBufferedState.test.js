const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

describe('Current-state subscription buffered mutations', () => {
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function pausedSnapshot(options, mutate, check) {
		const T = table({
			database: `bufferedSnapshot${++sequence}`,
			table: 'BufferedSnapshot',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		for (let i = 0; i < 150; i++) await T.put(`r${String(i).padStart(3, '0')}`, { value: 'seed' });
		const notices = [];
		const sibling = await T.subscribe({
			isCollection: true,
			omitCurrent: true,
			listener: (event) => notices.push(event),
		});
		let snapshot;
		try {
			snapshot = await T.subscribe({ isCollection: true, ...options });
			await waitFor(() => snapshot.queue?.length > 100 && snapshot.currentDrainResolver, { timeout: 5000 });
			if (!options.rowFilter) {
				assert.ok(snapshot.queue.some((event) => event.id === 'r000' && event.value?.value === 'seed'));
			}
			await mutate(T, notices);
			const mutation = notices.filter((event) => event.id === 'r000').at(-1);
			assert.ok(mutation && mutation.type !== 'message', 'mutation must be dispatched before publish');
			await T.publish('r000', { message: 'published' });
			await waitFor(() => notices.some((event) => event.id === 'r000' && event.type === 'message'));
			const message = notices.find((event) => event.id === 'r000' && event.type === 'message');
			const events = [];
			snapshot.on('data', (event) => events.push(event));
			await waitFor(
				() => events.some((event) => event.id === 'r149') && events.some((event) => event.type === 'message'),
				{ timeout: 5000 }
			);
			assert.deepStrictEqual(
				events.filter((event) => event.type === 'message').map((event) => [event.type, event.value, event.version]),
				[[message.type, message.value, message.version]],
				'message identity and payload must remain independent of refreshed row state'
			);
			await check(T, events, mutation, message);
		} finally {
			snapshot?.end();
			sibling.end();
		}
	}

	async function update(T, notices, id = 'r000', value = 'updated') {
		await T.put(id, { value });
		await waitFor(() => notices.some((event) => event.id === id && event.value?.value === value));
	}

	it('delivers a buffered update after a publish advances its version', async () => {
		await pausedSnapshot({}, update, async (T, events, _mutation, message) => {
			assert.strictEqual((await T.get('r000')).value, 'updated');
			const row = events.filter((event) => event.id === 'r000' && event.type === 'put').at(-1);
			assert.strictEqual(row.value.value, 'updated', 'updated row missing after publish');
			assert.strictEqual(row.version, message.version);
		});
	});

	for (const change of ['delete', 'invalidate']) {
		it(`delivers current row state after a buffered ${change} followed by publish`, async () => {
			await pausedSnapshot(
				{},
				async (T, notices) => {
					await T[change]('r000');
					await waitFor(() => notices.some((event) => event.id === 'r000' && event.type === change));
				},
				async (T, events) => {
					const current = await T.get('r000');
					const last = events.filter((event) => event.id === 'r000' && event.type !== 'message').at(-1);
					if (current) {
						assert.strictEqual(last.type, 'put');
						assert.deepStrictEqual({ ...last.value }, { ...current });
					} else assert.strictEqual(last.type, 'delete', 'deleted row must not remain at its scanned value');
				}
			);
		});
	}

	it('refreshes a buffered delete to the recreated row', async () => {
		await pausedSnapshot(
			{},
			async (T, notices) => {
				await T.delete('r000');
				await waitFor(() => notices.some((event) => event.id === 'r000' && event.type === 'delete'));
				await update(T, notices);
			},
			async (_T, events) => {
				assert.ok(!events.some((event) => event.id === 'r000' && event.type === 'delete'));
				assert.strictEqual(
					events.filter((event) => event.id === 'r000' && event.type === 'put').at(-1).value.value,
					'updated'
				);
			}
		);
	});

	it('does not regress a newer scanned value when older buffered updates drain', async () => {
		await pausedSnapshot(
			{},
			async (T, notices) => {
				await update(T, notices);
				await update(T, notices, 'r120', 'intermediate');
				await update(T, notices, 'r120', 'newest');
			},
			async (_T, events) => {
				const values = events.filter((event) => event.id === 'r120').map((event) => event.value?.value);
				assert.ok(values.length > 0);
				assert.strictEqual(values.at(-1), 'newest');
				assert.ok(!values.includes('intermediate'), JSON.stringify(values));
			}
		);
	});

	it('evaluates rowFilter against the refreshed row', async () => {
		await pausedSnapshot(
			{
				rowFilter: (row) => row.id !== 'r000' || row.value === 'updated',
				eventFilter: () => true,
			},
			update,
			async (_T, events) => {
				const rows = events.filter((event) => event.id === 'r000' && event.type === 'put');
				assert.ok(rows.length > 0, 'row that became readable must reach the subscriber');
				assert.ok(rows.every((event) => event.value.value === 'updated'));
			}
		);
	});

	it('keeps the stale-drop rule for raw current-only events', async () => {
		await pausedSnapshot({ rawEvents: true, includeSuperseded: false }, update, async (_T, events) => {
			assert.ok(!events.some((event) => event.id === 'r000' && event.value?.value === 'updated'));
		});
	});

	it('keeps historical mutation versions with includeSuperseded', async () => {
		await pausedSnapshot({ includeSuperseded: true }, update, async (_T, events, mutation, message) => {
			const row = events.filter((event) => event.id === 'r000' && event.value?.value === 'updated').at(-1);
			assert.ok(row);
			assert.strictEqual(row.version, mutation.version);
			assert.notStrictEqual(row.version, message.version);
		});
	});
});
