const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { cloneDeep } = require('lodash');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget, markDispatchTarget, copyQueryTarget } = require('#src/resources/RequestTarget');
const { AccessViolation } = require('#src/utility/errors/hdbError');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');

const database = 'delegated_query_reuse';
const AUTHORIZATION_SELECT = Symbol.for('harper.authorizationSelect');
const broadUser = {
	role: {
		permission: {
			[database]: { tables: { Employee: { read: true }, Department: { read: true }, Label: { read: true } } },
		},
	},
};
const restrictedUser = {
	role: {
		permission: {
			[database]: {
				tables: {
					Employee: { read: true },
					Department: {
						read: true,
						attribute_permissions: [
							{ attribute_name: 'id', read: true },
							{ attribute_name: 'label', read: true },
						],
					},
					Label: { read: true },
				},
			},
		},
	},
};
const ORDERS = [
	['broad then restricted', [broadUser, restrictedUser, broadUser]],
	['restricted then broad', [restrictedUser, broadUser, restrictedUser]],
];
const expected = (user) => ({
	id: 'e1',
	name: 'Ada',
	department: { id: 'd1', label: 'Engineering', ...(user === broadUser ? { secret: 'payroll' } : {}) },
});
const authoredSelect = () => ['id', 'name', { name: 'department', select: ['id', 'label', 'secret'] }];
const searchRoot = (extra) => ({
	conditions: [{ attribute: 'id', value: 'e1' }],
	select: authoredSelect(),
	checkPermission: true,
	...extra,
});
const plain = (value) => JSON.parse(JSON.stringify(value));

async function rows(results) {
	const collected = [];
	for await (const row of await results) collected.push(plain(row));
	return collected;
}
async function one(results) {
	const collected = await rows(results);
	assert.strictEqual(collected.length, 1, JSON.stringify(collected));
	return collected[0];
}
function assertAuthored(root) {
	assert.strictEqual(root.checkPermission, true, 'checkPermission');
	assert.deepStrictEqual(plain(root.select), authoredSelect(), 'select');
	assert.deepStrictEqual(Object.getOwnPropertySymbols(root), [], 'authorization symbols');
}
function refusedAsStale(error) {
	return error.statusCode === 500 && /already narrowed/.test(error.message);
}

describe('delegated reads reusing one query object', function () {
	this.timeout(30000);
	let Employee, FalseModeEmployee, Label, FalseModeLabel, DelegatingLabel, previousMainIsWorker;
	let sourceLoads = 0;
	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		const Department = table({
			database,
			table: 'Department',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'label', type: 'String' },
				{ name: 'secret', type: 'String' },
			],
		});
		Employee = table({
			database,
			table: 'Employee',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'departmentId', type: 'ID', indexed: true },
				{
					name: 'department',
					relationship: { from: 'departmentId' },
					type: 'Department',
					definition: { tableClass: Department },
				},
			],
		});
		FalseModeEmployee = class extends Employee {
			static loadAsInstance = false;
		};
		Label = table({
			database,
			table: 'Label',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'text', type: 'String' },
			],
		});
		Label.sourcedFrom({
			get(id) {
				sourceLoads++;
				return { id, text: `label ${id}` };
			},
		});
		FalseModeLabel = class extends Label {
			static loadAsInstance = false;
		};
		DelegatingLabel = class extends Resource {
			allowRead() {
				return true;
			}
			get(target) {
				target.checkPermission = true;
				return Label.get(target, this.getContext());
			}
		};
		await Department.put('d1', { id: 'd1', label: 'Engineering', secret: 'payroll' });
		await Employee.put('e1', { id: 'e1', name: 'Ada', departmentId: 'd1' });
		await Employee.put('50% off', { id: '50% off', name: 'Ada', departmentId: 'd1' });
	});
	after(function () {
		if (previousMainIsWorker !== undefined) setMainIsWorker(previousMainIsWorker);
	});

	for (const [mode, getTable] of [
		['default mode', () => Employee],
		['loadAsInstance = false', () => FalseModeEmployee],
	]) {
		describe(mode, function () {
			for (const [shape, create] of [
				['object', () => ({})],
				['array', () => []],
				['RequestTarget', () => new RequestTarget()],
			]) {
				it(`preserves non-enumerable query controls on a ${shape}`, async function () {
					const root = Object.defineProperties(create(), {
						conditions: { value: [{ attribute: 'id', value: 'e1' }] },
						select: { value: authoredSelect() },
						checkPermission: { value: true },
					});
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
				});
			}

			it('preserves an inherited row filter over an ancestor default', async function () {
				class BaseQuery {}
				BaseQuery.prototype.rowFilter = null;
				class Query extends BaseQuery {
					rowFilter(record) {
						return record.id === 'e1';
					}
				}
				const root = Object.assign(new Query(), {
					conditions: [],
					select: ['id'],
					checkPermission: true,
				});
				for (let attempt = 0; attempt < 2; attempt++)
					assert.deepStrictEqual(await rows(getTable().search(root, { user: broadUser })), [{ id: 'e1' }]);
				assert.strictEqual(Object.hasOwn(root, 'rowFilter'), false);
				assert.strictEqual(typeof root.rowFilter, 'function');
			});

			it('retains a non-enumerable filter on collection delete', async function () {
				const Store = table({
					database,
					table: `HiddenDelete${mode.replaceAll(/[^a-z]/gi, '')}`,
					attributes: [{ name: 'id', isPrimaryKey: true }],
				});
				class Delete extends Store {
					static loadAsInstance = getTable().loadAsInstance;
					allowDelete() {
						return true;
					}
				}
				await Store.put('keep', { id: 'keep' });
				const root = Object.defineProperty({ id: null, isCollection: true, checkPermission: true }, 'conditions', {
					value: [{ attribute: 'id', value: 'missing' }],
				});
				await Delete.delete(root, { user: broadUser });
				assert.strictEqual((await Store.get('keep')).id, 'keep');
				assert.strictEqual(root.conditions[0].value, 'missing');
			});

			it('reuses one-shot condition iterators without widening the next read', async function () {
				const conditions = (function* () {
					yield { attribute: 'id', value: 'e1' };
				})();
				const root = { conditions, select: authoredSelect(), checkPermission: true };
				for (const user of [broadUser, restrictedUser, broadUser])
					assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
				assert.strictEqual(root.conditions, conditions);
			});

			for (const placement of ['root', 'conditions']) {
				it(`reuses an iterable returning one cached iterator at ${placement}`, async function () {
					const iterator = (function* () {
						yield { attribute: 'id', value: 'e1' };
					})();
					const iterable = { [Symbol.iterator]: () => iterator };
					const root = { select: authoredSelect(), checkPermission: true };
					if (placement === 'root') root[Symbol.iterator] = iterable[Symbol.iterator];
					else root.conditions = iterable;
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
				});
			}

			for (const placement of ['root', 'conditions']) {
				it(`reads a next-only iterator at ${placement}`, async function () {
					const iterable = {
						[Symbol.iterator]() {
							let done = false;
							return {
								next() {
									if (done) return { done: true };
									done = true;
									return { done: false, value: { attribute: 'id', value: 'e1' } };
								},
							};
						},
					};
					const root = { select: authoredSelect(), checkPermission: true };
					if (placement === 'root') root[Symbol.iterator] = iterable[Symbol.iterator];
					else root.conditions = iterable;
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
				});
			}

			it('retains a next-only iterable filter on collection delete', async function () {
				const Store = getTable();
				class Delete extends Store {
					static loadAsInstance = Store.loadAsInstance;
					allowDelete() {
						return true;
					}
				}
				const conditions = {
					[Symbol.iterator]() {
						let done = false;
						return {
							next() {
								if (done) return { done: true };
								done = true;
								return { done: false, value: { attribute: 'id', value: 'missing' } };
							},
						};
					},
				};
				await Store.put('keep-next-only', { id: 'keep-next-only' });
				await Delete.delete({ id: null, isCollection: true, checkPermission: true, conditions }, { user: broadUser });
				assert.strictEqual((await Store.get('keep-next-only')).id, 'keep-next-only');
			});

			for (const placement of ['root', 'conditions']) {
				it(`retains cached iterator predicates on trusted reads at ${placement}`, async function () {
					let done = false;
					const iterator = {
						next() {
							if (done) return { done: true };
							done = true;
							return { done: false, value: { attribute: 'id', value: 'e1' } };
						},
					};
					const iterable = { [Symbol.iterator]: () => iterator };
					const root = { select: authoredSelect() };
					if (placement === 'root') root[Symbol.iterator] = iterable[Symbol.iterator];
					else root.conditions = iterable;
					for (let read = 0; read < 3; read++)
						assert.deepStrictEqual(await one(getTable().search(root, { user: broadUser })), expected(broadUser));
					assert.strictEqual(root.checkPermission, undefined);
				});
			}

			it('reads fresh predicates from a reusable iterable on each dispatch', async function () {
				let id = 'e1';
				const conditions = { [Symbol.iterator]: () => [{ attribute: 'id', value: id }][Symbol.iterator]() };
				const root = { conditions, select: authoredSelect(), checkPermission: true };
				assert.deepStrictEqual(await one(getTable().search(root, { user: broadUser })), expected(broadUser));
				id = '50% off';
				assert.deepStrictEqual(await one(getTable().search(root, { user: broadUser })), {
					...expected(broadUser),
					id,
				});
			});

			it('replays a one-shot iterator returned by a private-field getter', async function () {
				class Query {
					#conditions = (function* () {
						yield { attribute: 'id', value: 'e1' };
					})();
					get conditions() {
						return this.#conditions;
					}
					select = authoredSelect();
					checkPermission = true;
				}
				const root = new Query();
				for (const user of [broadUser, restrictedUser, broadUser])
					assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
			});

			it('rejects reentrant replay while retaining the completed snapshot', async function () {
				let reentrantChecks = 0;
				const root = { select: authoredSelect(), checkPermission: true };
				root.conditions = (function* () {
					assert.throws(() => [...copyQueryTarget(root).conditions], /while it is running/);
					reentrantChecks++;
					yield { attribute: 'id', value: 'e1' };
				})();
				for (const user of [broadUser, restrictedUser, broadUser])
					assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
				assert.strictEqual(reentrantChecks, 1);
			});

			it('keeps condition iterator failures closed on reuse', async function () {
				const failed = {
					conditions: (function* () {
						yield { attribute: 'id', value: 'e1' };
						throw new Error('iterator failed');
					})(),
					checkPermission: true,
				};
				for (const user of [broadUser, restrictedUser])
					await assert.rejects(async () => one(getTable().search(failed, { user })));
			});

			for (const [shape, Base] of [
				['class', class {}],
				['RequestTarget subclass', RequestTarget],
			]) {
				it(`reads an iterator getter on a query ${shape}`, async function () {
					class Query extends Base {
						#conditions = [{ attribute: 'id', value: 'e1' }];
						select = authoredSelect();
						checkPermission = true;
						get [Symbol.iterator]() {
							return function () {
								return this.#conditions[Symbol.iterator]();
							};
						}
					}
					const root = new Query();
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
				});

				it(`reads a private-field iterator on a query ${shape}`, async function () {
					class Query extends Base {
						#conditions = [{ attribute: 'id', value: 'e1' }];
						select = authoredSelect();
						checkPermission = true;
						[Symbol.iterator]() {
							return this.#conditions[Symbol.iterator]();
						}
					}
					const root = new Query();
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
				});
			}

			for (const [order, users] of ORDERS) {
				it(`search with one plain query object, ${order}`, async function () {
					const root = searchRoot();
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
				});

				it(`get with one plain query object, ${order}`, async function () {
					const root = { id: 'e1', select: authoredSelect(), checkPermission: true };
					for (const user of users) assert.deepStrictEqual(plain(await getTable().get(root, { user })), expected(user));
					assertAuthored(root);
				});

				it(`search with one RequestTarget, ${order}`, async function () {
					const root = new RequestTarget('?id=e1&id=e1');
					root.select = authoredSelect();
					root.checkPermission = true;
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
					assert.strictEqual(root.toString(), '?id=e1&id=e1');
					assert.deepStrictEqual(root.getAll('id'), ['e1', 'e1']);
				});

				it(`search with one array of conditions, ${order}`, async function () {
					const root = Object.assign([{ attribute: 'id', value: 'e1' }], {
						select: authoredSelect(),
						checkPermission: true,
					});
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assertAuthored(root);
					assert.deepStrictEqual(plain([...root]), [{ attribute: 'id', value: 'e1' }]);
				});

				it(`get with one programmatic RequestTarget, ${order}`, async function () {
					const root = new RequestTarget();
					root.id = '50% off';
					root.append('tag', 'a');
					root.append('tag', 'b');
					root.set('note', '100%');
					root.select = authoredSelect();
					root.checkPermission = true;
					for (const user of users)
						assert.deepStrictEqual(plain(await getTable().get(root, { user })), { ...expected(user), id: '50% off' });
					assertAuthored(root);
					assert.strictEqual(root.id, '50% off');
					assert.deepStrictEqual(
						[...root],
						[
							['tag', 'a'],
							['tag', 'b'],
							['note', '100%'],
						]
					);
				});

				it(`search with a RequestTarget subclass that computes its fields, ${order}`, async function () {
					const shared = { checkPermission: true, select: authoredSelect() };
					class EmployeeQuery extends RequestTarget {
						get conditions() {
							return [{ attribute: 'id', value: 'e1' }];
						}
						get checkPermission() {
							return shared.checkPermission;
						}
						set checkPermission(value) {
							shared.checkPermission = value;
						}
						get select() {
							return shared.select;
						}
						set select(value) {
							shared.select = value;
						}
					}
					const root = new EmployeeQuery();
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assert.strictEqual(shared.checkPermission, true);
					assert.deepStrictEqual(plain(shared.select), authoredSelect());
				});

				it(`search with a query object whose class defines accessors, ${order}`, async function () {
					const shared = { checkPermission: true, select: authoredSelect() };
					class AccessorQuery {
						conditions = [{ attribute: 'id', value: 'e1' }];
						get checkPermission() {
							return shared.checkPermission;
						}
						set checkPermission(value) {
							shared.checkPermission = value;
						}
						get select() {
							return shared.select;
						}
						set select(value) {
							shared.select = value;
						}
					}
					const root = new AccessorQuery();
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assert.strictEqual(shared.checkPermission, true);
					assert.deepStrictEqual(plain(shared.select), authoredSelect());
				});

				it(`search armed on the query and through the context, ${order}`, async function () {
					const root = searchRoot();
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user, authorize: true })), expected(user));
					assertAuthored(root);
				});

				it(`search armed only through the context, ${order}`, async function () {
					const root = searchRoot({ checkPermission: undefined });
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user, authorize: true })), expected(user));
					assertAuthored(root);
				});

				it(`search with an explicit permission, armed through the context, ${order}`, async function () {
					const root = searchRoot({ checkPermission: restrictedUser.role.permission });
					for (const user of users)
						assert.deepStrictEqual(await one(getTable().search(root, { user, authorize: true })), expected(user));
					assert.strictEqual(root.checkPermission, restrictedUser.role.permission);
					assert.deepStrictEqual(plain(root.select), authoredSelect());
					assert.deepStrictEqual(Object.getOwnPropertySymbols(root), []);
				});

				it(`direct instance search, ${order}`, async function () {
					const root = searchRoot();
					for (const user of users) {
						const resource = new (getTable())(null, { user, transaction: undefined });
						assert.deepStrictEqual(await one(resource.search(root)), expected(user));
					}
					assertAuthored(root);
				});
			}

			it('a target armed through a context is gated again on its next dispatch with that context', async function () {
				let gates = 0;
				class Counting extends getTable() {
					allowRead(user, target, context) {
						gates++;
						return super.allowRead(user, target, context);
					}
				}
				const root = { id: 'e1', select: authoredSelect() };
				const context = { user: restrictedUser, authorize: true };
				for (let dispatch = 0; dispatch < 2; dispatch++)
					assert.deepStrictEqual(plain(await Counting.get(root, context)), expected(restrictedUser));
				assert.strictEqual(gates, 2);
				assertAuthored(root);
			});

			for (const [shape, Base] of [
				['class', class {}],
				['RequestTarget subclass', RequestTarget],
			]) {
				it(`reads private-field accessors on a query ${shape}`, async function () {
					class PrivateQuery extends Base {
						#conditions = [{ attribute: 'id', value: 'e1' }];
						#select = authoredSelect();
						get conditions() {
							return this.#conditions;
						}
						get select() {
							return this.#select;
						}
						get checkPermission() {
							return true;
						}
						get unused() {
							throw new Error('unused getters must stay unevaluated');
						}
					}
					const root = new PrivateQuery();
					for (const user of [broadUser, restrictedUser, broadUser])
						assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
					assert.strictEqual(root.checkPermission, true);
					assert.deepStrictEqual(plain(root.select), authoredSelect());
					assert.deepStrictEqual(root.conditions, [{ attribute: 'id', value: 'e1' }]);
				});
			}

			it('normalizes iterable conditions on a frozen class copy', async function () {
				class FrozenQuery {
					id = 'e1';
					conditions = new Set([{ attribute: 'id', value: 'e1' }]);
					select = authoredSelect();
					checkPermission = true;
				}
				const root = Object.freeze(new FrozenQuery());
				for (const user of [restrictedUser, broadUser])
					assert.deepStrictEqual(await one(getTable().search(root, { user })), expected(user));
				assert.strictEqual(root.checkPermission, true);
				assert.deepStrictEqual(plain(root.select), authoredSelect());
				assert.deepStrictEqual([...root.conditions], [{ attribute: 'id', value: 'e1' }]);
			});

			it('copies a frozen query object of a class', async function () {
				class FrozenQuery {
					constructor() {
						this.id = 'e1';
						this.select = authoredSelect();
						this.checkPermission = true;
						Object.freeze(this);
					}
				}
				const root = new FrozenQuery();
				for (const user of [broadUser, restrictedUser])
					assert.deepStrictEqual(plain(await getTable().get(root, { user })), expected(user));
				assertAuthored(root);
			});

			it('a denied principal stays denied on the same query object', async function () {
				class DenyRestricted extends getTable() {
					allowRead(user, target, context) {
						return user === restrictedUser ? false : super.allowRead(user, target, context);
					}
				}
				const root = searchRoot();
				for (let attempt = 0; attempt < 2; attempt++) {
					await assert.rejects(
						async () => rows(await DenyRestricted.search(root, { user: restrictedUser })),
						AccessViolation
					);
				}
				assert.deepStrictEqual(await one(DenyRestricted.search(root, { user: broadUser })), expected(broadUser));
				assertAuthored(root);
			});

			it('async, throwing and rejecting allowRead overrides leave the query object armed', async function () {
				const verdicts = [
					async () => false,
					() => {
						throw new Error('policy failed');
					},
					async () => {
						throw new Error('policy unavailable');
					},
				];
				for (const verdict of verdicts) {
					class Gated extends getTable() {
						allowRead() {
							return verdict();
						}
					}
					const root = searchRoot();
					await assert.rejects(async () => rows(await Gated.search(root, { user: broadUser })), AccessViolation);
					assertAuthored(root);
				}
			});

			it('two principals authorizing one query object at the same time each get their own projection', async function () {
				let arrived = 0;
				let release;
				const released = new Promise((resolve) => (release = resolve));
				class Gated extends getTable() {
					async allowRead(user, target, context) {
						arrived++;
						await released;
						return super.allowRead(user, target, context);
					}
				}
				const root = searchRoot();
				const pending = [broadUser, restrictedUser].map((user) =>
					Promise.resolve(Gated.search(root, { user })).then(one)
				);
				const deadline = Date.now() + 5000;
				while (arrived < 2 && Date.now() < deadline) await delay(5);
				release();
				assert.strictEqual(arrived, 2, 'both authorizations were in flight together');
				assert.deepStrictEqual(await Promise.all(pending), [expected(broadUser), expected(restrictedUser)]);
				assertAuthored(root);
			});

			it('subscribe with one query object leaves it as written, for each principal', async function () {
				const root = { id: 'e1', checkPermission: true };
				for (const user of [broadUser, restrictedUser]) {
					const subscription = await getTable().subscribe(root, undefined, { user });
					assert.strictEqual(typeof subscription[Symbol.asyncIterator], 'function');
					subscription.end();
				}
				assert.strictEqual(root.checkPermission, true);
				assert.deepStrictEqual(Object.getOwnPropertySymbols(root), []);
			});
		});
	}

	describe('templates copied from a transport target', function () {
		const transportTarget = () => {
			const target = markDispatchTarget(new RequestTarget('/'));
			target.conditions = [{ attribute: 'id', value: 'e1' }];
			target.select = authoredSelect();
			target.checkPermission = true;
			return target;
		};
		const copies = {
			'spread': (target) => ({ ...target }),
			'Object.assign': (target) => Object.assign({}, target),
			'Object.assign onto a RequestTarget': (target) => Object.assign(new RequestTarget(), target),
			'lodash cloneDeep': (target) => cloneDeep({ ...target }),
			'structuredClone': (target) => structuredClone({ ...target }),
		};
		for (const [copyName, copy] of Object.entries(copies)) {
			for (const [order, users] of ORDERS) {
				it(`${copyName}, ${order}`, async function () {
					const template = copy(transportTarget());
					assert.deepStrictEqual(plain(template.conditions), [{ attribute: 'id', value: 'e1' }]);
					assertAuthored(template);
					for (const user of users)
						assert.deepStrictEqual(await one(FalseModeEmployee.search(template, { user })), expected(user));
					assertAuthored(template);
				});
			}
		}

		it('a transport target itself is authorized in place', async function () {
			const target = markDispatchTarget(new RequestTarget('/e1'));
			target.select = authoredSelect();
			target.checkPermission = restrictedUser.role.permission;
			assert.deepStrictEqual(plain(await Employee.get(target, { user: restrictedUser })), expected(restrictedUser));
			assert.strictEqual(target.checkPermission, false, 'the gate is consumed on the target itself');
			assert.strictEqual(target[AUTHORIZATION_SELECT], true);
			assert.deepStrictEqual(target.select[2].select, ['id', 'label'], 'the narrowed projection is on the target');
		});
	});

	describe('a query object an earlier authorization narrowed', function () {
		const stamp = (root) => {
			new Employee(null, { user: restrictedUser }).allowRead(restrictedUser, root, {});
			assert.strictEqual(root[AUTHORIZATION_SELECT], true);
			return root;
		};
		const stampedRoot = (extra) => stamp(searchRoot(extra));
		const stampedRecordRoot = () => stamp({ id: 'e1', select: authoredSelect(), checkPermission: true });
		const entries = {
			'search': (user) => rows(Employee.search(stampedRoot(), { user })),
			'get': (user) => Employee.get(stampedRecordRoot(), { user }),
			'false-mode search': (user) => rows(FalseModeEmployee.search(stampedRoot(), { user })),
			'false-mode get': (user) => FalseModeEmployee.get(stampedRecordRoot(), { user }),
			'subscribe': (user) => Employee.subscribe(stampedRecordRoot(), undefined, { user }),
			'false-mode subscribe': (user) => FalseModeEmployee.subscribe(stampedRecordRoot(), undefined, { user }),
			'direct instance search': (user) =>
				rows(new Employee(null, { user, transaction: undefined }).search(stampedRoot())),
		};
		for (const [entry, run] of Object.entries(entries)) {
			it(`is refused when ${entry} is asked to authorize it`, async function () {
				await assert.rejects(async () => run(broadUser), refusedAsStale);
				await assert.rejects(async () => run(restrictedUser), refusedAsStale);
			});
		}

		it('refuses a delegate reauthorizing a spread of its narrowed transport target', async function () {
			class Forwarding extends Employee {
				get(target) {
					return Employee.get({ ...target, checkPermission: true }, this.getContext());
				}
			}
			const target = markDispatchTarget(new RequestTarget('/e1'));
			target.select = authoredSelect();
			target.checkPermission = true;
			await assert.rejects(async () => Forwarding.get(target, { user: restrictedUser }), refusedAsStale);
		});

		it('is still served to a trusted read that asks for no authorization', async function () {
			const root = stampedRoot({ checkPermission: undefined });
			assert.deepStrictEqual(await one(Employee.search(root, {})), expected(restrictedUser));
		});

		it('is refused only after a pending body settles, and a rejected body keeps its own error', async function () {
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			try {
				let actionRan = false;
				class Recording extends Employee {
					put() {
						actionRan = true;
					}
				}
				const root = stampedRoot({ id: 'e9' });
				await assert.rejects(
					async () =>
						Recording.put(
							root,
							delay(10).then(() => ({ id: 'e9', name: 'Body' })),
							{ user: broadUser }
						),
					refusedAsStale
				);
				await assert.rejects(
					async () =>
						Recording.put(
							root,
							delay(10).then(() => Promise.reject(new Error('bad body'))),
							{ user: broadUser }
						),
					/bad body/
				);
				await delay(50);
				assert.strictEqual(actionRan, false);
				assert.deepStrictEqual(unhandled, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});
	});

	describe('arming through the context', function () {
		let Gated;
		before(function () {
			Gated = class extends Employee {
				allowRead(user, target, context) {
					return user !== restrictedUser && super.allowRead(user, target, context);
				}
			};
		});
		async function withoutUnhandledRejections(run) {
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			try {
				await run();
				await delay(50);
				assert.deepStrictEqual(unhandled, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		}

		it('gates a reused target while the arming dispatch still waits for its body, and after it fails', async function () {
			await withoutUnhandledRejections(async () => {
				const root = { id: 'e1' };
				const context = { user: restrictedUser, authorize: true };
				let rejectBody;
				const body = new Promise((_resolve, reject) => (rejectBody = reject));
				const put = Gated.put(root, body, context);
				await assert.rejects(async () => Gated.get(root, context), AccessViolation);
				rejectBody(new Error('bad body'));
				await assert.rejects(put, /bad body/);
				await assert.rejects(async () => Gated.get(root, context), AccessViolation);
				assert.strictEqual(root.checkPermission, true);
			});
		});

		it('fails on a frozen unarmed target without leaving its pending body unobserved', async function () {
			await withoutUnhandledRejections(async () => {
				const body = delay(10).then(() => Promise.reject(new Error('bad body')));
				await assert.rejects(
					async () => Gated.put(Object.freeze({ id: 'e1' }), body, { user: broadUser, authorize: true }),
					TypeError
				);
			});
		});
	});

	describe('cache disposition', function () {
		for (const [shape, lock] of [
			['frozen', Object.freeze],
			['sealed', Object.seal],
			['readonly status', (target) => Object.defineProperty(target, 'loadedFromSource', { value: undefined })],
		]) {
			for (const [mode, getTable] of [
				['default', () => Label],
				['false', () => FalseModeLabel],
				['delegate', () => DelegatingLabel],
			]) {
				it(`serves cache misses and hits for a ${shape} ${mode} target`, async function () {
					const id = `locked-${shape}-${mode}`;
					const loadsBefore = sourceLoads;
					for (let read = 0; read < 2; read++) {
						const target = lock({ id, checkPermission: true });
						assert.deepStrictEqual(plain(await getTable().get(target, { user: restrictedUser })), {
							id,
							text: `label ${id}`,
						});
						assert.strictEqual(target.loadedFromSource, undefined);
						assert.strictEqual(target.checkPermission, true);
					}
					assert.strictEqual(sourceLoads, loadsBefore + 1);
				});
			}
		}

		for (const [name, getTable, authorize, armedOnQuery] of [
			['a false-mode get', () => FalseModeLabel, undefined, true],
			['a false-mode get armed through the context as well', () => FalseModeLabel, true, true],
			['a false-mode get replacing an explicit permission', () => FalseModeLabel, true, broadUser.role.permission],
			['a false-mode get armed only through the context', () => FalseModeLabel, true, false],
			['a default-mode get', () => Label, undefined, true],
			['a default-mode delegate', () => DelegatingLabel, undefined, true],
			['a default-mode get armed only through the context', () => Label, true, false],
		]) {
			it(`${name} records it on the caller's query object`, async function () {
				const id = `k-${name.replaceAll(' ', '-')}`;
				const query = () => (armedOnQuery ? { id, checkPermission: armedOnQuery } : { id });
				const loadsBefore = sourceLoads;
				const miss = query();
				assert.deepStrictEqual(plain(await getTable().get(miss, { user: restrictedUser, authorize })), {
					id,
					text: `label ${id}`,
				});
				assert.strictEqual(miss.loadedFromSource, true);
				assert.strictEqual(sourceLoads, loadsBefore + 1);
				const hit = query();
				await getTable().get(hit, { user: restrictedUser, authorize });
				assert.strictEqual(hit.loadedFromSource, false);
				assert.strictEqual(hit.checkPermission, armedOnQuery || true);
				assert.deepStrictEqual(Object.getOwnPropertySymbols(hit), []);
			});
		}
	});
});
