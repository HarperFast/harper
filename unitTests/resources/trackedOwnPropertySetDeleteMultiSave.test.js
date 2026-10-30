'use strict';

const assert = require('node:assert');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { hasChanges, collapseChanges, releaseOwnBaseline, updateAndFreeze } = require('#src/resources/tracked');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('Tracked record own properties vs set/deleteProperty/addTo, across saves', () => {
	let TrackedLifecycleTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		TrackedLifecycleTable = table({
			table: 'TrackedLifecycleTable',
			database: 'test_tracked_own_lifecycle',
			audit: true,
			sealed: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'count', type: 'Float' },
				{ name: 'countInt', type: 'Int' },
				{ name: 'countLong', type: 'Long' },
			],
		});
	});

	describe('Single-save baseline behavior (positive control)', () => {
		it('persists single-save own property, set(), addTo/subtractFrom, and excludes untouched subclass field baseline', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('pos-control', {
				title: 'v1',
				count: 10,
				countInt: 5,
				countLong: 100,
			});

			await transaction(async (ctx) => {
				const rec = await WithField.update('pos-control', ctx);
				rec.extra = 'hello';
				rec.set('title', 'v2');
				rec.addTo('count', 3);
				rec.subtractFrom('countInt', 2);
				assert.strictEqual(hasChanges(rec), true);
			});

			const saved = await TrackedLifecycleTable.get('pos-control');
			assert.strictEqual(saved.title, 'v2');
			assert.strictEqual(saved.extra, 'hello');
			assert.strictEqual(saved.count, 13);
			assert.strictEqual(saved.countInt, 3);
			assert.strictEqual(saved.hits, undefined);
		});
	});

	describe('In-transaction set() and deleteProperty() after own-property assignment', () => {
		it('commits set() after an own-property write on an undeclared property and on a Table subclass field (including when the own property matches the stored value)', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('arm2a-set', {
				title: 'init',
				sameAsStored: 'stored-v1',
				hits: 0,
			});

			await transaction(async (ctx) => {
				const rec = await WithField.update('arm2a-set', ctx);
				rec.extra = 'v1';
				rec.set('extra', 'v2');

				rec.hits = 5;
				rec.set('hits', 9);

				rec.sameAsStored = 'stored-v1';
				rec.set('sameAsStored', 'stored-v2');

				assert.strictEqual(rec.extra, 'v2');
				assert.strictEqual(rec.hits, 9);
				assert.strictEqual(rec.sameAsStored, 'stored-v2');
				assert.strictEqual(hasChanges(rec), true);
			});

			const saved = await TrackedLifecycleTable.get('arm2a-set');
			assert.strictEqual(saved.extra, 'v2');
			assert.strictEqual(saved.hits, 9);
			assert.strictEqual(saved.sameAsStored, 'stored-v2');
		});

		it('commits deleteProperty() after an own-property write on both a persisted and a newly assigned undeclared property', async () => {
			await TrackedLifecycleTable.put('arm2a-delete', {
				title: 'init',
				persistedExtra: 'keep-or-delete',
			});

			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('arm2a-delete', ctx);
				rec.persistedExtra = 'keep-or-delete';
				rec.tempExtra = 'temp';
				rec.deleteProperty('persistedExtra');
				rec.deleteProperty('tempExtra');

				assert.strictEqual(hasChanges(rec), true);
				assert.strictEqual(rec.persistedExtra, undefined);
				assert.strictEqual(rec.tempExtra, undefined);
			});

			const saved = await TrackedLifecycleTable.get('arm2a-delete');
			assert.strictEqual(saved.persistedExtra, undefined);
			assert.strictEqual(saved.tempExtra, undefined);
		});
	});

	describe('Multi-save lifecycle across sequential save() calls and held locks ({ hold: true })', () => {
		it('persists set() and deleteProperty() in a second save after a prior save committed an own property or Table subclass field', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('arm2b-tx-multisave', {
				title: 'init',
				hits: 0,
			});

			await transaction(async (ctx) => {
				const rec = await WithField.update('arm2b-tx-multisave', ctx);
				rec.extra = 'v1';
				rec.toDelete = 'temp';
				rec.hits = 10;
				await rec.save();

				releaseOwnBaseline(rec, { extra: 'v1', toDelete: 'temp', hits: 10 });
				rec.setRecord({ id: 'arm2b-tx-multisave', title: 'init', extra: 'v1', toDelete: 'temp', hits: 10 });

				await rec.update();
				rec.set('extra', 'v2');
				rec.set('hits', 20);
				rec.deleteProperty('toDelete');
				assert.strictEqual(hasChanges(rec), true);
				await rec.save();
			});

			const saved = await TrackedLifecycleTable.get('arm2b-tx-multisave');
			assert.strictEqual(saved.extra, 'v2');
			assert.strictEqual(saved.hits, 20);
			assert.strictEqual(saved.toDelete, undefined);

			if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') {
				await TrackedLifecycleTable.put('arm2b-held-multisave', {
					title: 'init',
				});
				const held = await TrackedLifecycleTable.lock('arm2b-held-multisave', { hold: true, lease: 10_000 });
				try {
					held.extra = 'v1';
					held.toDelete = 'temp';
					await held.save();

					held.set('extra', 'v2');
					held.deleteProperty('toDelete');
					assert.strictEqual(hasChanges(held), true);
					await held.save();
				} finally {
					await held.unlock();
				}

				const savedHeld = await TrackedLifecycleTable.get('arm2b-held-multisave');
				assert.strictEqual(savedHeld.extra, 'v2');
				assert.strictEqual(savedHeld.toDelete, undefined);
			}
		});

		it('stages a CRDT Addition (__op__: add) in a second save when addTo() is called after a prior save committed an own property or subclass field, and composes after set()', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('arm2b-addto-crdt', {
				title: 'init',
				hits: 0,
			});

			await transaction(async (ctx) => {
				const rec = await WithField.update('arm2b-addto-crdt', ctx);
				rec.hits = 10;
				rec.extraCount = 10;
				rec.setThenAdd = 10;
				const patch1 = collapseChanges(rec, rec.getChanges());
				assert.strictEqual(patch1.hits, 10);
				assert.strictEqual(patch1.extraCount, 10);
				assert.strictEqual(patch1.setThenAdd, 10);

				releaseOwnBaseline(rec, patch1);
				const committedAfterSave1 = updateAndFreeze(rec, patch1, false);
				rec.setRecord(committedAfterSave1);
				rec._setChanges(undefined);

				assert.strictEqual(hasChanges(rec), false);

				rec.addTo('hits', 5);
				rec.addTo('extraCount', 5);
				rec.set('setThenAdd', 50);
				rec.addTo('setThenAdd', 5);

				const patch2 = collapseChanges(rec, rec.getChanges());
				assert.strictEqual(patch2.hits?.__op__, 'add');
				assert.strictEqual(patch2.hits?.value, 5);
				assert.strictEqual(patch2.extraCount?.__op__, 'add');
				assert.strictEqual(patch2.extraCount?.value, 5);
				assert.strictEqual(patch2.setThenAdd, 55);

				const committedAfterSave2 = updateAndFreeze(rec, patch2, false);
				assert.strictEqual(committedAfterSave2.hits, 15);
				assert.strictEqual(committedAfterSave2.extraCount, 15);
				assert.strictEqual(committedAfterSave2.setThenAdd, 55);
			});

			if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') {
				await TrackedLifecycleTable.put('arm2b-held-addto', {
					title: 'init',
					hits: 0,
				});
				await TrackedLifecycleTable.put('arm2b-held-anchor', { title: 'anchor' });

				let held;
				await transaction(async (ctx) => {
					const anchor = await WithField.update('arm2b-held-anchor', ctx);
					held = await anchor.lock('arm2b-held-addto', { hold: true, lease: 10_000 });
				});
				try {
					held.hits = 10;
					held.extraCount = 10;
					held.setThenAdd = 10;
					await held.save();

					held.addTo('hits', 5);
					held.addTo('extraCount', 5);
					held.set('setThenAdd', 50);
					held.addTo('setThenAdd', 5);
					assert.strictEqual(hasChanges(held), true);
					const patch2 = collapseChanges(held, held.getChanges());
					assert.strictEqual(patch2.hits?.__op__, 'add');
					assert.strictEqual(patch2.hits?.value, 5);
					assert.strictEqual(patch2.extraCount?.__op__, 'add');
					assert.strictEqual(patch2.extraCount?.value, 5);
					assert.strictEqual(patch2.setThenAdd, 55);
					await held.save();
				} finally {
					await held.unlock();
				}

				const savedHeld = await TrackedLifecycleTable.get('arm2b-held-addto');
				assert.strictEqual(savedHeld.hits, 15);
				assert.strictEqual(savedHeld.extraCount, 15);
				assert.strictEqual(savedHeld.setThenAdd, 55);
			}
		});
	});

	describe('addTo/subtractFrom with bigint deltas on declared numeric attributes (Float, Int, Long) and fullUpdate subclass baseline shadowing', () => {
		it('accepts bigint deltas in addTo/subtractFrom on declared Float, Int, and Long schema attributes and composes with number deltas', async () => {
			await TrackedLifecycleTable.put('arm3-bigint-delta', {
				title: 'init',
				count: 10,
				countInt: 5,
				countLong: 100,
			});

			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('arm3-bigint-delta', ctx);
				rec.addTo('count', 1n);
				rec.addTo('count', 0.5);
				rec.addTo('countInt', 2n);
				rec.subtractFrom('countInt', 1n);
				rec.addTo('countLong', 50n);
				rec.subtractFrom('countLong', 10n);
			});

			const saved = await TrackedLifecycleTable.get('arm3-bigint-delta');
			assert.strictEqual(saved.count, 11.5);
			assert.strictEqual(saved.countInt, 6);
			assert.strictEqual(saved.countLong, 140);
		});

		it('accepts bigint deltas in fullUpdate addTo/subtractFrom on declared Float, Int, and Long attributes and unshadows untouched Table subclass fields on set()/addTo()', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('arm3-fullupdate-bigint', {
				title: 'init',
				count: 10,
				countInt: 5,
				countLong: 100,
				hits: 10,
			});

			await transaction(async (ctx) => {
				const rec = await WithField.update('arm3-fullupdate-bigint', ctx);
				await rec.update(
					{
						id: 'arm3-fullupdate-bigint',
						title: 'replaced',
						count: 10,
						countInt: 5,
						countLong: 100,
						hits: 10,
					},
					true
				);
				rec.addTo('count', 2n);
				rec.subtractFrom('countInt', 1n);
				rec.addTo('countLong', 5n);
				rec.addTo('hits', 5);
				assert.strictEqual(rec.hits, 15);
			});

			const saved = await TrackedLifecycleTable.get('arm3-fullupdate-bigint');
			assert.strictEqual(saved.title, 'replaced');
			assert.strictEqual(saved.count, 12);
			assert.strictEqual(saved.countInt, 4);
			assert.strictEqual(saved.countLong, 105);
			assert.strictEqual(saved.hits, 15);
		});
	});

	describe('Edge cases of the own-property contract', () => {
		it('rejects a bigint beyond 2^53 on a number attribute with a 400 before any fold rounds it, and leaves the record unchanged', async () => {
			await TrackedLifecycleTable.put('edge-bigint-bound', { title: 'init', countLong: 1, count: 1 });
			const beyond = 9007199254740993n;
			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('edge-bigint-bound', ctx);
				rec.set('countLong', 0);
				assert.throws(() => rec.addTo('countLong', beyond), { statusCode: 400 });
				rec.addTo('count', 1);
				assert.throws(() => rec.addTo('count', beyond), { statusCode: 400 });
				assert.throws(() => (rec.countLong = beyond), { statusCode: 400 });
				rec.addTo('countLong', 9007199254740992n);
			});
			const saved = await TrackedLifecycleTable.get('edge-bigint-bound');
			assert.strictEqual(saved.countLong, 9007199254740992);
			assert.strictEqual(saved.count, 2);
		});

		it('keeps full bigint precision for an addTo on an undeclared bigint property', async () => {
			await TrackedLifecycleTable.put('edge-bigint-undeclared', { title: 'init', dynamicBig: 0n });
			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('edge-bigint-undeclared', ctx);
				rec.addTo('dynamicBig', 2n ** 60n + 1n);
			});
			const saved = await TrackedLifecycleTable.get('edge-bigint-undeclared');
			assert.strictEqual(saved.dynamicBig, 2n ** 60n + 1n);
		});

		it('reads a plain { __op__: add } envelope as the value it gives the property', async () => {
			await TrackedLifecycleTable.put('edge-plain-op', { title: 'init', extra: 5, count: 1 });
			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('edge-plain-op', ctx);
				rec.set('extra', { __op__: 'add', value: 2 });
				rec.set('count', { __op__: 'add', value: 3 });
				assert.strictEqual(rec.extra, 7);
				assert.strictEqual(rec.get('extra'), 7);
				assert.strictEqual(rec.count, 4);
				assert.strictEqual(rec.toJSON().extra, 7);
			});
			const saved = await TrackedLifecycleTable.get('edge-plain-op');
			assert.strictEqual(saved.extra, 7);
			assert.strictEqual(saved.count, 4);
		});

		it('saves an in-place edit of an own object the previous save committed', async () => {
			await TrackedLifecycleTable.put('edge-own-object', { title: 'init' });
			await transaction(async (ctx) => {
				const rec = await TrackedLifecycleTable.update('edge-own-object', ctx);
				rec.meta = { a: 1 };
				await rec.save();
				await rec.update();
				rec.meta.a = 2;
				assert.strictEqual(hasChanges(rec), true);
			});
			const saved = await TrackedLifecycleTable.get('edge-own-object');
			assert.deepStrictEqual(saved.meta, { a: 2 });
		});

		it('an addTo on an untouched declared class field stages an addition that its reads reflect', async () => {
			class WithDeclaredField extends TrackedLifecycleTable {
				countInt = 0;
			}
			await TrackedLifecycleTable.put('edge-class-field-add', { title: 'init', countInt: 5 });
			await transaction(async (ctx) => {
				const rec = await WithDeclaredField.update('edge-class-field-add', ctx);
				rec.addTo('countInt', 5);
				assert.strictEqual(rec.countInt, 10);
				assert.strictEqual(rec.get('countInt'), 10);
				assert.strictEqual(collapseChanges(rec, rec.getChanges()).countInt?.__op__, 'add');
			});
			assert.strictEqual((await TrackedLifecycleTable.get('edge-class-field-add')).countInt, 10);
		});

		it('an own assignment back to the stored value after set() or addTo() keeps the stored value', async () => {
			class WithField extends TrackedLifecycleTable {
				hits = 0;
			}
			await TrackedLifecycleTable.put('edge-own-after-set', { title: 'init', extra: 'v1', hits: 100 });
			await transaction(async (ctx) => {
				const rec = await WithField.update('edge-own-after-set', ctx);
				rec.set('extra', 'v2');
				rec.extra = 'v1';
				rec.addTo('hits', 5);
				assert.strictEqual(Object.hasOwn(rec, 'hits'), false);
				rec.hits = 100;
				assert.strictEqual(rec.get('extra'), 'v1');
				assert.strictEqual(rec.get('hits'), 100);
			});
			const saved = await TrackedLifecycleTable.get('edge-own-after-set');
			assert.strictEqual(saved.extra, 'v1');
			assert.strictEqual(saved.hits, 100);
		});

		it('a full-update addTo adds to an assigned class field and moves it into the changes', async () => {
			class WithDeclaredField extends TrackedLifecycleTable {
				countInt = 0;
			}
			await TrackedLifecycleTable.put('edge-full-update-own', { title: 'init', countInt: 5 });
			await transaction(async (ctx) => {
				const rec = await WithDeclaredField.update('edge-full-update-own', ctx);
				await rec.update({ id: 'edge-full-update-own', title: 'replaced', countInt: 5 }, true);
				rec.countInt = 7;
				rec.addTo('countInt', 1);
				assert.strictEqual(rec.countInt, 8);
				assert.strictEqual(Object.hasOwn(rec, 'countInt'), false);
			});
			const saved = await TrackedLifecycleTable.get('edge-full-update-own');
			assert.strictEqual(saved.title, 'replaced');
			assert.strictEqual(saved.countInt, 8);
		});
	});
});
