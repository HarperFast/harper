// Legacy allow* hooks are operation gates. In loadAsInstance=false mode the Table methods own
// those gates because the static Resource wrapper deliberately does not invoke model hooks.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function fromAsync(iterable) {
	const results = [];
	for await (const value of iterable) results.push(value);
	return results;
}

function permissionFor(tablePermission = {}) {
	return {
		role: {
			permission: {
				test: {
					tables: {
						OperationAuthDocs: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							...tablePermission,
						},
					},
				},
			},
		},
	};
}

const isAccessViolation = (error) => error.statusCode === 403 || /unauthorized/i.test(error.message);

describe('operation-scoped write authorization', () => {
	let Docs;
	let alice;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Docs = table({
			table: 'OperationAuthDocs',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'kind', indexed: true },
				{ name: 'owner' },
				{ name: 'label' },
			],
		});
		alice = { username: 'alice', ...permissionFor() };
	});

	async function seed(kind, rows) {
		for (const row of rows) await Docs.put({ kind, ...row });
	}

	async function recordsOf(kind) {
		return fromAsync(Docs.search(new RequestTarget(`?kind=${kind}`), {}));
	}

	async function idsOf(kind) {
		return (await recordsOf(kind)).map((record) => record.id).sort();
	}

	describe('loadAsInstance=false', () => {
		it('authorizes an array put once with allowUpdate and the original batch', async function () {
			const calls = [];
			let createCalls = 0;
			class CollectionPut extends Docs {
				static loadAsInstance = false;
				allowUpdate(_user, batch) {
					calls.push({ batch, isCollection: this.isCollection, owner: this.owner });
					return true;
				}
				allowCreate() {
					createCalls++;
					return false;
				}
			}
			const batch = [
				{ id: 'false-put-a', owner: 'alice', kind: 'false-put', label: 'one' },
				{ id: 'false-put-b', owner: 'bob', kind: 'false-put', label: 'two' },
			];
			await CollectionPut.put(batch, { user: alice, authorize: true });
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].batch, batch);
			assert.strictEqual(calls[0].isCollection, true);
			assert.strictEqual(calls[0].owner, undefined);
			assert.strictEqual(createCalls, 0);
			assert.deepStrictEqual(await idsOf('false-put'), ['false-put-a', 'false-put-b']);
		});

		it('blocks the entire array before writing when the collection allowUpdate denies', async function () {
			class DeniedCollectionPut extends Docs {
				static loadAsInstance = false;
				allowUpdate() {
					return false;
				}
			}
			await assert.rejects(
				async () =>
					DeniedCollectionPut.put(
						[
							{ id: 'false-put-denied-a', kind: 'false-put-denied' },
							{ id: 'false-put-denied-b', kind: 'false-put-denied' },
						],
						{ user: alice, authorize: true }
					),
				isAccessViolation
			);
			assert.deepStrictEqual(await idsOf('false-put-denied'), []);
		});

		it('authorizes a query delete once with allowDelete before scanning', async function () {
			await seed('false-delete', [
				{ id: 'false-delete-a', owner: 'alice' },
				{ id: 'false-delete-b', owner: 'bob' },
			]);
			const deleteCalls = [];
			const readTargets = [];
			let internalScanTarget;
			let concurrentRead;
			const target = new RequestTarget('?kind=false-delete');
			target.select = ['owner'];
			class CollectionDelete extends Docs {
				static loadAsInstance = false;
				allowDelete(_user, target) {
					deleteCalls.push({ target, isCollection: this.isCollection, owner: this.owner });
					return true;
				}
				allowRead(_user, readTarget) {
					readTargets.push(readTarget);
					return false;
				}
				search(scanTarget) {
					internalScanTarget = scanTarget;
					concurrentRead = fromAsync(super.search(target));
					return super.search(scanTarget);
				}
			}
			await CollectionDelete.delete(target, { user: alice, authorize: true });
			assert.strictEqual(deleteCalls.length, 1);
			assert.strictEqual(deleteCalls[0].target, target);
			assert.strictEqual(deleteCalls[0].isCollection, true);
			assert.strictEqual(deleteCalls[0].owner, undefined);
			assert.deepStrictEqual(await concurrentRead, []);
			assert.ok(readTargets.length > 0, 'the concurrent read must still execute allowRead');
			assert.notStrictEqual(internalScanTarget, target);
			assert.strictEqual(internalScanTarget.checkPermission, false);
			assert.deepStrictEqual(internalScanTarget.select, ['$id']);
			assert.ok(target.checkPermission, 'the caller target remains armed for a later dispatch');
			assert.deepStrictEqual(target.select, ['owner']);
			assert.deepStrictEqual(await idsOf('false-delete'), []);
		});

		it('fails before a query-delete scan when allowDelete denies or rejects', async function () {
			await seed('false-delete-denied', [{ id: 'false-delete-denied-a' }, { id: 'false-delete-denied-b' }]);
			let denyCalls = 0;
			class DeniedCollectionDelete extends Docs {
				static loadAsInstance = false;
				async allowDelete() {
					denyCalls++;
					return false;
				}
			}
			await assert.rejects(
				() =>
					DeniedCollectionDelete.delete(new RequestTarget('?kind=false-delete-denied'), {
						user: alice,
						authorize: true,
					}),
				isAccessViolation
			);
			assert.strictEqual(denyCalls, 1);

			class RejectingCollectionDelete extends Docs {
				static loadAsInstance = false;
				async allowDelete() {
					throw new Error('hook failed');
				}
			}
			await assert.rejects(
				() =>
					RejectingCollectionDelete.delete(new RequestTarget('?kind=false-delete-denied'), {
						user: alice,
						authorize: true,
					}),
				isAccessViolation
			);
			assert.deepStrictEqual(await idsOf('false-delete-denied'), ['false-delete-denied-a', 'false-delete-denied-b']);
		});

		it('re-authorizes a reused query-delete target without relying on caller mutation', async function () {
			await seed('false-delete-reused', [{ id: 'false-delete-reused-a' }]);
			let allowDeleteCalls = 0;
			let readCalls = 0;
			class ReusedTargetDelete extends Docs {
				static loadAsInstance = false;
				allowDelete() {
					return ++allowDeleteCalls === 1;
				}
				allowRead() {
					readCalls++;
					return false;
				}
			}
			const target = new RequestTarget('?kind=false-delete-reused');
			const context = { user: alice, authorize: true };
			await ReusedTargetDelete.delete(target, context);
			await seed('false-delete-reused', [{ id: 'false-delete-reused-b' }]);
			await assert.rejects(() => ReusedTargetDelete.delete(target, context), isAccessViolation);
			assert.strictEqual(allowDeleteCalls, 2);
			assert.strictEqual(readCalls, 0, 'the authorized delete scan must never substitute allowRead');
			assert.deepStrictEqual(await idsOf('false-delete-reused'), ['false-delete-reused-b']);
		});

		it('normalizes a rejecting collection allowUpdate to AccessViolation before writing', async function () {
			class RejectingCollectionPut extends Docs {
				static loadAsInstance = false;
				async allowUpdate() {
					throw new Error('hook failed');
				}
			}
			await assert.rejects(
				() =>
					RejectingCollectionPut.put([{ id: 'false-put-rejected', kind: 'false-put-rejected' }], {
						user: alice,
						authorize: true,
					}),
				isAccessViolation
			);
			assert.deepStrictEqual(await idsOf('false-put-rejected'), []);
		});

		it('authorizes publish once with allowCreate and never allowDelete', async function () {
			await seed('false-publish', [{ id: 'false-publish-record', owner: 'alice' }]);
			const createCalls = [];
			let deleteCalls = 0;
			class CollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate(_user, message) {
					createCalls.push({ message, owner: this.owner });
					return true;
				}
				allowDelete() {
					deleteCalls++;
					return false;
				}
			}
			const message = { type: 'notice', owner: 'alice' };
			await CollectionPublish.publish('false-publish-record', message, { user: alice, authorize: true });
			assert.strictEqual(createCalls.length, 1);
			assert.strictEqual(createCalls[0].message, message);
			assert.strictEqual(createCalls[0].owner, undefined);
			assert.strictEqual(deleteCalls, 0);
		});

		it('does not publish when allowCreate rejects', async function () {
			let writes = 0;
			class RejectingCollectionPublish extends Docs {
				static loadAsInstance = false;
				async allowCreate() {
					throw new Error('hook failed');
				}
				_writePublish(...args) {
					writes++;
					return super._writePublish(...args);
				}
			}
			await assert.rejects(
				() =>
					RejectingCollectionPublish.publish(
						'false-publish-rejected',
						{ type: 'notice' },
						{
							user: alice,
							authorize: true,
						}
					),
				isAccessViolation
			);
			assert.strictEqual(writes, 0);
		});

		it('checks allowCreate before publishing undefined or URLSearchParams bodies', async function () {
			const checkedMessages = [];
			let writes = 0;
			class DeniedCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate(_user, message) {
					checkedMessages.push(message);
					return false;
				}
				_writePublish(...args) {
					writes++;
					return super._writePublish(...args);
				}
			}
			const params = new URLSearchParams('type=notice');
			await assert.rejects(
				async () =>
					DeniedCollectionPublish.publish('false-publish-undefined', undefined, { user: alice, authorize: true }),
				isAccessViolation
			);
			await assert.rejects(
				async () => DeniedCollectionPublish.publish('false-publish-params', params, { user: alice, authorize: true }),
				isAccessViolation
			);
			assert.deepStrictEqual(checkedMessages, [undefined, params]);
			assert.strictEqual(writes, 0);
		});

		it('checks allowCreate when the static target is a plain URLSearchParams', async function () {
			const checkedMessages = [];
			let writes = 0;
			class DeniedCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate(_user, message) {
					checkedMessages.push(message);
					return false;
				}
				_writePublish() {
					writes++;
				}
			}
			const undefinedTarget = new URLSearchParams('channel=one');
			undefinedTarget.id = 'plain-target-undefined';
			const paramsTarget = new URLSearchParams('channel=two');
			paramsTarget.id = 'plain-target-params';
			const paramsBody = new URLSearchParams('type=notice');
			await assert.rejects(
				async () => DeniedCollectionPublish.publish(undefinedTarget, undefined, { user: alice, authorize: true }),
				isAccessViolation
			);
			await assert.rejects(
				async () => DeniedCollectionPublish.publish(paramsTarget, paramsBody, { user: alice, authorize: true }),
				isAccessViolation
			);
			const frozenTarget = Object.freeze({ id: 'frozen-object-undefined', checkPermission: true });
			await assert.rejects(
				async () => DeniedCollectionPublish.publish(frozenTarget, undefined, { user: alice }),
				isAccessViolation
			);
			assert.deepStrictEqual(checkedMessages, [undefined, paramsBody, undefined]);
			assert.strictEqual(writes, 0);
		});

		it('checks allowCreate when the static target is a plain object', async function () {
			const checkedMessages = [];
			let writes = 0;
			class DeniedCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate(_user, message) {
					checkedMessages.push(message);
					return false;
				}
				_writePublish() {
					writes++;
				}
			}
			const paramsBody = new URLSearchParams('type=notice');
			await assert.rejects(
				async () =>
					DeniedCollectionPublish.publish({ id: 'plain-object-undefined' }, undefined, {
						user: alice,
						authorize: true,
					}),
				isAccessViolation
			);
			await assert.rejects(
				async () =>
					DeniedCollectionPublish.publish({ id: 'plain-object-params' }, paramsBody, { user: alice, authorize: true }),
				isAccessViolation
			);
			assert.deepStrictEqual(checkedMessages, [undefined, paramsBody]);
			assert.strictEqual(writes, 0);
		});

		it('keeps authorization armed for concurrent publishes sharing one target', async function () {
			let allowCreateCalls = 0;
			let writes = 0;
			let dispatch = 0;
			const gates = [];
			class ConcurrentCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate() {
					allowCreateCalls++;
					return false;
				}
				async publish(target, message) {
					const index = dispatch++;
					await new Promise((resolve) => (gates[index] = resolve));
					return super.publish(target, message);
				}
				_writePublish() {
					writes++;
				}
			}
			const sharedTarget = { id: 'shared-publish-target' };
			const first = ConcurrentCollectionPublish.publish(sharedTarget, undefined, { user: alice, authorize: true });
			const second = ConcurrentCollectionPublish.publish(sharedTarget, undefined, { user: alice, authorize: true });
			gates[0]();
			await assert.rejects(first, isAccessViolation);
			gates[1]();
			await assert.rejects(second, isAccessViolation);
			assert.strictEqual(allowCreateCalls, 2);
			assert.strictEqual(writes, 0);
		});

		it('keeps static publish authorization when an override copies the target', async function () {
			let allowCreateCalls = 0;
			let writes = 0;
			class CopyingCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate() {
					allowCreateCalls++;
					return false;
				}
				publish(target, message) {
					return super.publish(Object.assign(new RequestTarget(), target), message);
				}
				_writePublish() {
					writes++;
				}
			}
			await assert.rejects(
				async () =>
					CopyingCollectionPublish.publish('copied-publish-target', undefined, {
						user: alice,
						authorize: true,
					}),
				isAccessViolation
			);
			assert.strictEqual(allowCreateCalls, 1);
			assert.strictEqual(writes, 0);
		});

		it('keeps static publish authorization for delegation after the override settles', async function () {
			let allowCreateCalls = 0;
			let writes = 0;
			let delayedPublish;
			class DelayedCollectionPublish extends Docs {
				static loadAsInstance = false;
				allowCreate() {
					allowCreateCalls++;
					return false;
				}
				publish(target, message) {
					delayedPublish = new Promise((resolve, reject) =>
						setImmediate(() => {
							try {
								resolve(super.publish(Object.assign(new RequestTarget(), target), message));
							} catch (error) {
								reject(error);
							}
						})
					);
					delayedPublish.catch(() => {});
				}
				_writePublish() {
					writes++;
				}
			}
			await DelayedCollectionPublish.publish('delayed-publish-target', undefined, {
				user: alice,
				authorize: true,
			});
			await assert.rejects(delayedPublish, isAccessViolation);
			assert.strictEqual(allowCreateCalls, 1);
			assert.strictEqual(writes, 0);
		});
	});

	describe('loadAsInstance default compatibility', () => {
		it('keeps one collection-entry allowDelete verdict for a query delete', async function () {
			await seed('instance-delete', [
				{ id: 'instance-delete-a', owner: 'alice' },
				{ id: 'instance-delete-b', owner: 'bob' },
			]);
			const calls = [];
			class InstanceDelete extends Docs {
				allowDelete(_user, target) {
					calls.push({ target, owner: this.owner });
					return true;
				}
			}
			const target = new RequestTarget('?kind=instance-delete');
			await InstanceDelete.delete(target, { user: alice, authorize: true });
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].target, target);
			assert.strictEqual(calls[0].owner, undefined);
			assert.deepStrictEqual(await idsOf('instance-delete'), []);
		});

		it('keeps a RequestTarget publish body as the message in default mode', async function () {
			let published;
			class InstancePublish extends Docs {
				_writePublish(...args) {
					published = args;
				}
			}
			const body = new RequestTarget();
			body.id = 'body-id';
			await InstancePublish.publish('expected-id', body, { user: alice });
			assert.strictEqual(published[0], 'expected-id');
			assert.strictEqual(published[1], body);
		});
	});
});
