require('../../../testUtils');
const assert = require('node:assert');
const nodePath = require('node:path');
const { setupTestDBPath } = require('../../../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const {
	registerApplicationTools,
	_setResourcesForTest,
	_setRequestTargetForTest,
	_resetApplicationToolsRegisteredForTest,
} = require('#src/components/mcp/tools/application');
const { getTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { _resetPromptRegistryForTest } = require('#src/components/mcp/promptRegistry');
const { defineResource, t, schemaOf } = require('#src/resources/defineResource');
const { defineTable, types } = require('#src/resources/defineTable');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { generateJsonApi } = require('#src/resources/openApi');

const sdkDir = nodePath.dirname(require.resolve('@modelcontextprotocol/sdk/package.json'));
const Ajv2020 = require(require.resolve('ajv/dist/2020', { paths: [sdkDir] })).default;

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const CTX = { user: SUPER, profile: 'application', sessionId: 'optional-body' };

function strict2020(schema) {
	const stripped = JSON.parse(JSON.stringify(schema, (key, value) => (key === 'nullable' ? undefined : value)));
	return new Ajv2020({ strict: false, validateFormats: false }).compile(stripped);
}

describe('MCP application tools with .optional request contract bodies', () => {
	let TrackTable;
	let captured;
	let resources;
	let ReqIntake;
	let ReqWidget;
	let OptIntake;
	let OptWidget;
	let OptTrack;
	let OptNote;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TrackTable = defineTable(
			'OptionalBodyTrack',
			{
				id: types.id.primaryKey,
				title: types.string.indexed,
				status: types.enum(['draft', 'published']).indexed,
			},
			{ database: 'mcp_contract_optional_body' }
		);
	});

	beforeEach(() => {
		captured = [];
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setRequestTargetForTest(RequestTarget);

		ReqIntake = defineResource(
			{
				path: '/req-intake',
				post: {
					body: t.object({
						name: t.string,
						note: t.string.optional,
					}),
				},
			},
			{
				async post(target, data) {
					captured.push({ route: 'req-intake', isCollection: target.isCollection, data });
					return { created: true, name: data.name };
				},
			}
		);

		class ReqWidgetClass extends Resource.withSchema({
			path: '/req-widget/:id',
			put: {
				query: { dryRun: t.boolean.optional },
				body: t.object({ reason: t.string }),
			},
		}) {
			async put(target, data) {
				captured.push({
					route: 'req-widget/:id',
					id: target.id,
					dryRun: target.get('dryRun'),
					data,
				});
				return { ok: true };
			}
		}
		ReqWidget = ReqWidgetClass;

		OptIntake = defineResource(
			{
				path: '/opt-intake',
				post: {
					body: t.object({
						name: t.string,
						note: t.string.optional,
					}).optional,
				},
			},
			{
				async post(target, data) {
					captured.push({ route: 'opt-intake', isCollection: target.isCollection, data });
					return { accepted: true, hasBody: data !== undefined };
				},
			}
		);

		class OptWidgetClass extends Resource.withSchema({
			path: '/opt-widget/:id',
			put: {
				query: { dryRun: t.boolean.optional },
				body: t.object({
					reason: t.string,
					tag: t.string.optional,
				}).optional,
			},
		}) {
			async put(target, data) {
				captured.push({
					route: 'opt-widget/:id',
					id: target.id,
					dryRun: target.get('dryRun'),
					data,
				});
				return { ok: true, hasBody: data !== undefined };
			}
		}
		OptWidget = OptWidgetClass;

		OptTrack = defineResource(
			{
				path: '/opt-track/:id',
				patch: {
					body: schemaOf({ table: TrackTable, projection: 'insert' }).optional,
				},
			},
			{
				async patch(target, data) {
					captured.push({
						route: 'opt-track/:id',
						id: target.id,
						data,
					});
					return { ok: true, hasBody: data !== undefined };
				},
			}
		);

		OptNote = defineResource(
			{
				path: '/opt-note/:id',
				put: {
					body: t.object({
						note: t.string.optional,
					}).optional,
				},
			},
			{
				async put(target, data) {
					captured.push({
						route: 'opt-note/:id',
						id: target.id,
						data,
					});
					return { ok: true, hasBody: data !== undefined };
				},
			}
		);

		resources = new Resources();
		resources.set('req-intake', ReqIntake);
		resources.set('req-widget/:id', ReqWidget);
		resources.set('opt-intake', OptIntake);
		resources.set('opt-widget/:id', OptWidget);
		resources.set('opt-track/:id', OptTrack);
		resources.set('opt-note/:id', OptNote);

		_setResourcesForTest(resources);
		registerApplicationTools();
	});

	afterEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	describe('Arm 1 (Positive Control) — required contract bodies and explicitly supplied .optional contract bodies', () => {
		it('enforces required contract bodies in schema metadata and at runtime', async () => {
			assert.strictEqual(ReqIntake.inputSchemas.post.bodyRequired, true);
			assert.strictEqual(ReqWidget.inputSchemas.put.bodyRequired, true);

			const api = generateJsonApi(resources, 'https://harper.fast');
			assert.strictEqual(api.paths['/req-intake'].post.requestBody.required, true);
			assert.strictEqual(api.paths['/req-widget/{id}'].put.requestBody.required, true);

			const createTool = getTool('create_reqintake');
			const updateTool = getTool('update_reqwidget_id');
			assert.ok(createTool, 'create_reqintake registered');
			assert.ok(updateTool, 'update_reqwidget_id registered');
			assert.deepStrictEqual(createTool.inputSchema.required, ['name']);
			assert.deepStrictEqual(updateTool.inputSchema.required, ['id', 'reason']);

			const createRes = await createTool.handler({ name: 'Widget A' }, CTX);
			assert.strictEqual(createRes.isError, undefined, JSON.stringify(createRes));
			assert.deepStrictEqual(createRes.structuredContent, { created: true, name: 'Widget A' });

			const updateRes = await updateTool.handler({ id: 'w1', dryRun: true, reason: 'restock' }, CTX);
			assert.strictEqual(updateRes.isError, undefined, JSON.stringify(updateRes));
			assert.deepStrictEqual(captured, [
				{ route: 'req-intake', isCollection: true, data: { name: 'Widget A' } },
				{ route: 'req-widget/:id', id: 'w1', dryRun: true, data: { reason: 'restock' } },
			]);

			const missingBodyRes = await updateTool.handler({ id: 'w1' }, CTX);
			assert.strictEqual(missingBodyRes.isError, true);
			const errPayload = JSON.parse(missingBodyRes.content[0].text);
			assert.strictEqual(errPayload.code, 'ValidationError');
			assert.ok(
				Array.isArray(errPayload.errors) &&
					errPayload.errors.some((e) => e.path === 'body.reason' && e.code === 'required'),
				`expected body.reason:required, got: ${JSON.stringify(errPayload)}`
			);
		});

		it('accepts a valid explicitly supplied .optional body and rejects a partially supplied invalid body', async () => {
			const updateOptTool = getTool('update_optwidget_id');
			assert.ok(updateOptTool, 'update_optwidget_id registered');

			const okRes = await updateOptTool.handler({ id: 'w1', dryRun: true, reason: 'manual' }, CTX);
			assert.strictEqual(okRes.isError, undefined, JSON.stringify(okRes));
			assert.deepStrictEqual(captured, [
				{
					route: 'opt-widget/:id',
					id: 'w1',
					dryRun: true,
					data: { reason: 'manual' },
				},
			]);

			const partialInvalidRes = await updateOptTool.handler({ id: 'w1', tag: 'v1' }, CTX);
			assert.strictEqual(partialInvalidRes.isError, true);
			const errPayload = JSON.parse(partialInvalidRes.content[0].text);
			assert.strictEqual(errPayload.code, 'ValidationError');
			assert.ok(
				Array.isArray(errPayload.errors) &&
					errPayload.errors.some((e) => e.path === 'body.reason' && e.code === 'required'),
				`expected body.reason:required when optional body is partially supplied, got: ${JSON.stringify(errPayload)}`
			);
		});
	});

	describe('Arm 2 (Defect Arm A) — contractInputSchema must not promote body.required into tool.inputSchema.required when bodyRequired === false', () => {
		it('keeps body properties optional on create_optintake when post.body is .optional', () => {
			assert.strictEqual(OptIntake.inputSchemas.post.bodyRequired, false);
			const api = generateJsonApi(resources, 'https://harper.fast');
			assert.strictEqual(api.paths['/opt-intake'].post.requestBody.required, undefined);

			const tool = getTool('create_optintake');
			assert.ok(tool, 'create_optintake registered');
			assert.strictEqual(
				tool.inputSchema.required,
				undefined,
				`optional body must not promote body.required into root tool.inputSchema.required, got: ${JSON.stringify(tool.inputSchema.required)}`
			);
			const validate = strict2020(tool.inputSchema);
			assert.strictEqual(
				validate({}),
				true,
				`Ajv2020 must accept an empty args object when post.body is .optional: ${JSON.stringify(validate.errors)}`
			);
		});

		it('requires only path param :id on update_optwidget_id when put.body is .optional', () => {
			assert.strictEqual(OptWidget.inputSchemas.put.bodyRequired, false);
			const api = generateJsonApi(resources, 'https://harper.fast');
			assert.strictEqual(api.paths['/opt-widget/{id}'].put.requestBody.required, undefined);

			const tool = getTool('update_optwidget_id');
			assert.ok(tool, 'update_optwidget_id registered');
			assert.deepStrictEqual(
				tool.inputSchema.required,
				['id'],
				`optional body must leave only path param :id in tool.inputSchema.required, got: ${JSON.stringify(tool.inputSchema.required)}`
			);
			const validate = strict2020(tool.inputSchema);
			assert.strictEqual(
				validate({ id: 'w1' }),
				true,
				`Ajv2020 must accept { id } without body properties: ${JSON.stringify(validate.errors)}`
			);
			assert.strictEqual(
				validate({ id: 'w1', dryRun: true }),
				true,
				`Ajv2020 must accept { id, dryRun } without body properties: ${JSON.stringify(validate.errors)}`
			);
		});

		it('requires only path param :id on patch_opttrack_id when patch.body is schemaOf(insert).optional', () => {
			assert.strictEqual(OptTrack.inputSchemas.patch.bodyRequired, false);
			const api = generateJsonApi(resources, 'https://harper.fast');
			assert.strictEqual(api.paths['/opt-track/{id}'].patch.requestBody.required, undefined);

			const tool = getTool('patch_opttrack_id');
			assert.ok(tool, 'patch_opttrack_id registered');
			assert.deepStrictEqual(
				tool.inputSchema.required,
				['id'],
				`optional table-projected body must not promote ['title', 'status'] into tool.inputSchema.required, got: ${JSON.stringify(tool.inputSchema.required)}`
			);
			const validate = strict2020(tool.inputSchema);
			assert.strictEqual(
				validate({ id: 't1' }),
				true,
				`Ajv2020 must accept { id } when patch.body is .optional: ${JSON.stringify(validate.errors)}`
			);
		});
	});

	describe('Arm 3 (Defect Arm B) — contractBody must forward undefined (not {}) when an .optional body is omitted from MCP args', () => {
		it('(3a) dispatches create_optintake with data === undefined when called with {} or undefined', async () => {
			const tool = getTool('create_optintake');
			assert.ok(tool, 'create_optintake registered');

			const resEmptyObj = await tool.handler({}, CTX);
			assert.strictEqual(
				resEmptyObj.isError,
				undefined,
				`create_optintake({}) should succeed when post.body is .optional, got: ${resEmptyObj.content?.[0]?.text}`
			);

			const resUndefined = await tool.handler(undefined, CTX);
			assert.strictEqual(
				resUndefined.isError,
				undefined,
				`create_optintake(undefined) should succeed when post.body is .optional, got: ${resUndefined.content?.[0]?.text}`
			);

			assert.deepStrictEqual(captured, [
				{ route: 'opt-intake', isCollection: true, data: undefined },
				{ route: 'opt-intake', isCollection: true, data: undefined },
			]);
		});

		it('(3a) dispatches update_optwidget_id and patch_opttrack_id with data === undefined when only path/query args are supplied', async () => {
			const updateTool = getTool('update_optwidget_id');
			const patchTool = getTool('patch_opttrack_id');
			assert.ok(updateTool, 'update_optwidget_id registered');
			assert.ok(patchTool, 'patch_opttrack_id registered');

			const resPathOnly = await updateTool.handler({ id: 'w1' }, CTX);
			assert.strictEqual(
				resPathOnly.isError,
				undefined,
				`update_optwidget_id({ id: 'w1' }) should succeed when put.body is .optional, got: ${resPathOnly.content?.[0]?.text}`
			);

			const resPathAndQuery = await updateTool.handler({ id: 'w2', dryRun: true }, CTX);
			assert.strictEqual(
				resPathAndQuery.isError,
				undefined,
				`update_optwidget_id({ id: 'w2', dryRun: true }) should succeed when put.body is .optional, got: ${resPathAndQuery.content?.[0]?.text}`
			);

			const resPatch = await patchTool.handler({ id: 't1' }, CTX);
			assert.strictEqual(
				resPatch.isError,
				undefined,
				`patch_opttrack_id({ id: 't1' }) should succeed when patch.body is .optional, got: ${resPatch.content?.[0]?.text}`
			);

			assert.deepStrictEqual(captured, [
				{ route: 'opt-widget/:id', id: 'w1', dryRun: undefined, data: undefined },
				{ route: 'opt-widget/:id', id: 'w2', dryRun: true, data: undefined },
				{ route: 'opt-track/:id', id: 't1', data: undefined },
			]);
		});

		it('(3b) passes data === undefined (not {}) to handler when an .optional body with only optional properties is omitted', async () => {
			const directTarget = new RequestTarget('/opt-note/n1');
			directTarget.id = 'n1';
			await OptNote.put(directTarget, undefined);
			assert.deepStrictEqual(captured, [{ route: 'opt-note/:id', id: 'n1', data: undefined }]);

			captured.length = 0;
			const tool = getTool('update_optnote_id');
			assert.ok(tool, 'update_optnote_id registered');
			const res = await tool.handler({ id: 'n1' }, CTX);
			assert.strictEqual(res.isError, undefined, JSON.stringify(res));
			assert.deepStrictEqual(
				captured,
				[{ route: 'opt-note/:id', id: 'n1', data: undefined }],
				`expected omitted .optional body to reach handler as undefined, got: ${JSON.stringify(captured)}`
			);
		});
	});
});
