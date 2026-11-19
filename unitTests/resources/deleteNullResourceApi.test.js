// Caller shapes of the Resource-API `delete`, pinned for upgrade-impact checks.
// v5.2.0 (commit 672fd5b61, harper#1837, first tagged v5.2.0-beta.1) made the inherited static delete throw for a
// bare null/undefined first argument. Before it, `transactional()` normalized that argument into a
// whole-collection target with no conditions: on v5.1.26 each shape here that now fails with the "value of
// undefined/null for delete" ClientError resolved `true` after deleting every record (a non-table Resource's
// instance delete got a `{ isCollection: true }` target instead). The request-contract resources did not exist yet.
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource } = require('#src/resources/Resource');
const { defineResource } = require('#src/resources/defineResource');
const { ClientError } = require('#src/utility/errors/hdbError');
const assert = require('node:assert');

const superUser = { username: 'delete-shapes', role: { permission: { super_user: true } } };

function nullIdRejection(value, method = 'delete') {
	return (error) => {
		assert.ok(error instanceof ClientError, `expected a ClientError, got ${error}`);
		assert.strictEqual(error.statusCode, 400);
		assert.strictEqual(error.message, `Using an argument with a value of ${value} for ${method}, is not allowed`);
		return true;
	};
}

// the target server/REST.ts builds; exercises dispatch only, not HTTP routing or authentication
function restTarget(relativeURL) {
	const target = new RequestTarget(relativeURL);
	target.async = true;
	target.checkPermission = superUser.role.permission;
	return target;
}

describe('Resource-API delete caller shapes', function () {
	this.timeout(30000);
	let Shapes;

	before(async () => {
		setupTestDBPath();
		await loadGQLSchema(`
		type NullIdResourceDelete @table {
			id: Int @primaryKey
			name: String @indexed
		}`);
		Shapes = tables.NullIdResourceDelete;
	});

	beforeEach(async () => {
		await transaction((context) => Shapes.delete({}, context));
		await transaction((context) =>
			Promise.all([
				Shapes.put({ id: 1, name: 'a' }, context),
				Shapes.put({ id: 2, name: 'b' }, context),
				Shapes.put({ id: 3, name: 'c' }, context),
			])
		);
		assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
	});

	async function liveIds() {
		await Shapes.primaryStore.flushed;
		// deletes leave tombstone entries in the primary store, so list only live values
		const ids = [];
		for (const entry of Shapes.primaryStore.getRange({ start: true })) if (entry.value != null) ids.push(entry.key);
		return ids;
	}

	describe('inherited static delete (the transactional() wrapper)', () => {
		describe('bare null/undefined first argument: throws ClientError 400 synchronously', () => {
			it('Table.delete()', async () => {
				assert.throws(() => Shapes.delete(), nullIdRejection(undefined));
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(undefined)', async () => {
				assert.throws(() => Shapes.delete(undefined), nullIdRejection(undefined));
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(null)', async () => {
				assert.throws(() => Shapes.delete(null), nullIdRejection(null));
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(variable) where the variable is undefined at runtime', async () => {
				const params = {};
				assert.throws(() => Shapes.delete(params.id), nullIdRejection(undefined));
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(undefined, context) and Table.delete(null, context)', async () => {
				await transaction(async (context) => {
					assert.throws(() => Shapes.delete(undefined, context), nullIdRejection(undefined));
					assert.throws(() => Shapes.delete(null, context), nullIdRejection(null));
				});
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('static method calling this.delete()', async () => {
				class PurgeAll extends Shapes {
					static purge() {
						return this.delete();
					}
				}
				assert.throws(() => PurgeAll.purge(), nullIdRejection(undefined));
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(undefined).catch(handler): the throw escapes the promise chain', async () => {
				let handled = false;
				assert.throws(
					() =>
						Shapes.delete(undefined).catch(() => {
							handled = true;
						}),
					nullIdRejection(undefined)
				);
				assert.strictEqual(handled, false);
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(undefined, context) uncaught after another write in the same transaction', async () => {
				// v5.1.26: both the put and the delete-everything committed, leaving only id 9
				await assert.rejects(
					transaction(async (context) => {
						await Shapes.put({ id: 9, name: 'z' }, context);
						return Shapes.delete(undefined, context);
					}),
					nullIdRejection(undefined)
				);
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete(undefined, context) caught inside the transaction after another write', async () => {
				// v5.1.26: ids 1-3 were deleted and the put committed
				await transaction(async (context) => {
					await Shapes.put({ id: 9, name: 'z' }, context);
					assert.throws(() => Shapes.delete(undefined, context), nullIdRejection(undefined));
				});
				assert.deepStrictEqual(await liveIds(), [1, 2, 3, 9]);
			});

			it('CustomResource.delete() on a non-table Resource with an instance delete', () => {
				const targets = [];
				class CustomResource extends Resource {
					delete(target) {
						targets.push(target);
						return true;
					}
				}
				assert.throws(() => CustomResource.delete(), nullIdRejection(undefined));
				assert.deepStrictEqual(targets, []);
			});
		});

		describe('scalar id or object target: same result on v5.1.26', () => {
			it('Table.delete(id) deletes that record', async () => {
				assert.strictEqual(await Shapes.delete(2), true);
				assert.deepStrictEqual(await liveIds(), [1, 3]);
			});

			it('Table.delete(id) for an id with no record deletes nothing', async () => {
				assert.strictEqual(await Shapes.delete(999), true);
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});

			it('Table.delete({}) deletes every record', async () => {
				assert.strictEqual(await Shapes.delete({}), true);
				assert.deepStrictEqual(await liveIds(), []);
			});

			it('Table.delete({ id: undefined }) deletes every record', async () => {
				// a known gap, not a contract: the v5.2.0 guard covers only a bare argument
				assert.strictEqual(await Shapes.delete({ id: undefined }), true);
				assert.deepStrictEqual(await liveIds(), []);
			});

			it('Table.delete({ id: null }) deletes every record', async () => {
				assert.strictEqual(await Shapes.delete({ id: null }), true);
				assert.deepStrictEqual(await liveIds(), []);
			});

			it('Table.delete({ id }) deletes that record', async () => {
				assert.strictEqual(await Shapes.delete({ id: 2 }), true);
				assert.deepStrictEqual(await liveIds(), [1, 3]);
			});

			it('Table.delete({ conditions }) deletes the matching records', async () => {
				assert.strictEqual(await Shapes.delete({ conditions: [{ attribute: 'name', value: 'b' }] }), true);
				assert.deepStrictEqual(await liveIds(), [1, 3]);
			});

			it('CustomResource.delete({}) hands the instance delete a collection target', async () => {
				const targets = [];
				class CustomResource extends Resource {
					delete(target) {
						targets.push(target);
						return true;
					}
				}
				assert.strictEqual(await CustomResource.delete({}), true);
				assert.strictEqual(targets.length, 1);
				assert.strictEqual(targets[0].isCollection, true);
			});
		});

		describe('REST-shaped RequestTarget: same result on v5.1.26', () => {
			it('DELETE /Table/ (the collection path) deletes every record', async () => {
				assert.strictEqual(await Shapes.delete(restTarget('/'), { user: superUser }), true);
				assert.deepStrictEqual(await liveIds(), []);
			});

			it('DELETE /Table/?attribute=value deletes the matching records', async () => {
				assert.strictEqual(await Shapes.delete(restTarget('/?name=b'), { user: superUser }), true);
				assert.deepStrictEqual(await liveIds(), [1, 3]);
			});

			it('DELETE /Table/<id> deletes that record', async () => {
				assert.strictEqual(await Shapes.delete(restTarget('/2'), { user: superUser }), true);
				assert.deepStrictEqual(await liveIds(), [1, 3]);
			});

			it('DELETE /Table (no trailing slash) rejects with 400 and deletes nothing', async () => {
				// only the message changed: "Invalid primary key type: undefined" before harper#1807 (v5.2.0-beta.2)
				await assert.rejects(Shapes.delete(restTarget(''), { user: superUser }), (error) => {
					assert.ok(error instanceof ClientError);
					assert.strictEqual(error.statusCode, 400);
					return true;
				});
				assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
			});
		});
	});

	describe('static delete overrides', () => {
		it('synchronous override delegating to super.delete(target, context), called with no argument, throws', async () => {
			class Delegating extends Shapes {
				static delete(target, context) {
					return super.delete(target, context);
				}
			}
			assert.throws(() => Delegating.delete(), nullIdRejection(undefined));
			assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
		});

		it('async override delegating to super.delete(target, context), called with no argument, rejects', async () => {
			class AsyncDelegating extends Shapes {
				static async delete(target, context) {
					return super.delete(target, context);
				}
			}
			let caught;
			await AsyncDelegating.delete().catch((error) => {
				caught = error;
			});
			assert.ok(nullIdRejection(undefined)(caught));
			assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
		});

		it('override that does not call super runs with an undefined target', async () => {
			const targets = [];
			class OwnDelete extends Shapes {
				static delete(target) {
					targets.push(target);
					return 'handled';
				}
			}
			assert.strictEqual(OwnDelete.delete(), 'handled');
			assert.deepStrictEqual(targets, [undefined]);
			assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
		});
	});

	describe('instance delete: same result on v5.1.26', () => {
		it('instance.delete() on an instance with an id deletes that record', async () => {
			await transaction(async (context) => {
				const instance = await Shapes.update(2, context);
				assert.strictEqual(await instance.delete(), true);
			});
			assert.deepStrictEqual(await liveIds(), [1, 3]);
		});

		it('Table.delete(id) on a class whose instance delete(target) override calls super.delete(target)', async () => {
			const ids = [];
			class Audited extends Shapes {
				delete(target) {
					ids.push(target.id);
					return super.delete(target);
				}
			}
			assert.strictEqual(await Audited.delete(2), true);
			assert.deepStrictEqual(ids, [2]);
			assert.deepStrictEqual(await liveIds(), [1, 3]);
		});

		for (const loadAsInstance of [undefined, false]) {
			describe(`this.delete() inside an instance method, loadAsInstance = ${loadAsInstance}`, () => {
				let Remover;
				before(() => {
					Remover = class extends Shapes {
						static loadAsInstance = loadAsInstance;
						post() {
							return this.delete();
						}
					};
				});

				it('on a record request (POST /Table/<id>) deletes that record', async () => {
					await Remover.post(restTarget('/2'), {}, { user: superUser });
					assert.deepStrictEqual(await liveIds(), [1, 3]);
				});

				it('on a collection request (POST /Table/) rejects with 400 and deletes nothing', async () => {
					await assert.rejects(Remover.post(restTarget('/'), {}, { user: superUser }), (error) => {
						assert.ok(error instanceof ClientError);
						assert.strictEqual(error.statusCode, 400);
						assert.strictEqual(error.message, 'Invalid primary key of null');
						return true;
					});
					assert.deepStrictEqual(await liveIds(), [1, 2, 3]);
				});
			});
		}
	});

	describe('static get', () => {
		it('Table.get(), Table.get(undefined) and Table.get(null) throw ClientError 400', () => {
			// already rejected before v5.2.0, but as a plain Error with no statusCode (672fd5b61)
			assert.throws(() => Shapes.get(), nullIdRejection(undefined, 'get'));
			assert.throws(() => Shapes.get(undefined), nullIdRejection(undefined, 'get'));
			assert.throws(() => Shapes.get(null), nullIdRejection(null, 'get'));
		});
	});

	describe('request-contract resources (new in v5.2.0)', () => {
		it('Resource.withSchema subclass: SchemaResource.delete() throws ClientError 400', () => {
			class SchemaResource extends Resource.withSchema({ path: '/contracted', delete: {} }) {
				delete() {
					return true;
				}
			}
			assert.throws(() => SchemaResource.delete(), nullIdRejection(undefined));
		});

		it('defineResource object: resource.delete() calls the handler with an undefined target', () => {
			const targets = [];
			const Defined = defineResource(
				{ path: '/defined', delete: {} },
				{
					delete(target) {
						targets.push(target);
						return true;
					},
				}
			);
			assert.strictEqual(Defined.delete(), true);
			assert.deepStrictEqual(targets, [undefined]);
		});
	});

	after(async () => {
		await Shapes?.indexingOperation;
	});
});
