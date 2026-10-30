const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { cloneDeep } = require('lodash');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { RequestTarget, markDispatchTarget } = require('#src/resources/RequestTarget');
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
	let Employee, FalseModeEmployee, Label, FalseModeLabel, previousMainIsWorker;
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
		await Department.put('d1', { id: 'd1', label: 'Engineering', secret: 'payroll' });
		await Employee.put('e1', { id: 'e1', name: 'Ada', departmentId: 'd1' });
		await Employee.put('50% off', { id: '50% off', name: 'Ada', departmentId: 'd1' });
	});
	after(function () {
		setMainIsWorker(previousMainIsWorker);
	});

	for (const [mode, getTable] of [
		['default mode', () => Employee],
		['loadAsInstance = false', () => FalseModeEmployee],
	]) {
		describe(mode, function () {
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
			});
		}

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
		for (const [name, getTable, authorize, armedOnQuery] of [
			['a false-mode get', () => FalseModeLabel, undefined, true],
			['a false-mode get armed through the context as well', () => FalseModeLabel, true, true],
			['a false-mode get armed only through the context', () => FalseModeLabel, true, false],
			['a default-mode get', () => Label, undefined, true],
			['a default-mode get armed only through the context', () => Label, true, false],
		]) {
			it(`${name} records it on the caller's query object`, async function () {
				const id = `k-${name.replaceAll(' ', '-')}`;
				const query = () => (armedOnQuery ? { id, checkPermission: true } : { id });
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
				assert.strictEqual(hit.checkPermission, true);
				assert.deepStrictEqual(Object.getOwnPropertySymbols(hit), []);
			});
		}
	});
});
