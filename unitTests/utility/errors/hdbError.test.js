const assert = require('assert');
const {
	appendErrorContext,
	handleHDBError,
	hdbErrors,
	IndexRebuildingError,
	ServerError,
	TransactionCommitConflictTimeoutError,
} = require('#src/utility/errors/hdbError');
const { errorForLog } = require('#src/utility/logging/harper_logger');
const PermissionResponseObject = require('#src/security/data_objects/PermissionResponseObject').default;

describe('IndexRebuildingError', () => {
	it('is a retryable 503 ServerError with a stable machine-readable code', () => {
		const err = new IndexRebuildingError('"path" is not indexed yet, can not search for this attribute');
		assert(err instanceof ServerError, 'should extend ServerError');
		assert(err instanceof Error);
		assert.equal(err.name, 'IndexRebuildingError');
		assert.equal(err.statusCode, 503);
		assert.equal(err.code, 'INDEX_REBUILDING');
		assert.equal(err.retryable, true);
		assert.equal(err.message, '"path" is not indexed yet, can not search for this attribute');
	});
});

describe('TransactionCommitConflictTimeoutError', () => {
	it('is a 503 ServerError with a stable machine-readable code', () => {
		const err = new TransactionCommitConflictTimeoutError('abandoned', true);
		assert(err instanceof ServerError, 'should extend ServerError');
		assert(err instanceof Error);
		assert.strictEqual(err.name, 'TransactionCommitConflictTimeoutError');
		assert.strictEqual(err.statusCode, 503);
		assert.strictEqual(err.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.strictEqual(err.message, 'abandoned');
	});

	// Retryability is per-instance, not per-class: a multi-store transaction whose earlier store
	// already committed must not advertise a retry that would replay that store's durable writes.
	it('carries the caller-decided retryability', () => {
		assert.strictEqual(new TransactionCommitConflictTimeoutError('abandoned', true).retryable, true);
		assert.strictEqual(new TransactionCommitConflictTimeoutError('abandoned', false).retryable, false);
	});
});

describe('appendErrorContext', () => {
	it('appends to a writable message', () => {
		const err = new Error('base');
		appendErrorContext(err, ' while resolving record 1 for T');
		assert.strictEqual(err.message, 'base while resolving record 1 for T');
	});

	// What `fetch` rejects with when an AbortSignal.timeout fires: `message` is a getter-only
	// accessor on the prototype, so a plain assignment throws under strict mode.
	it('appends to a DOMException without throwing', () => {
		const err = new DOMException('aborted', 'TimeoutError');
		appendErrorContext(err, ' while resolving record 1 for T');
		assert.strictEqual(err.message, 'aborted while resolving record 1 for T');
		assert.strictEqual(err.name, 'TimeoutError');
	});

	it('leaves a frozen error intact rather than throwing', () => {
		const err = Object.freeze(new Error('frozen'));
		appendErrorContext(err, ' extra');
		assert.strictEqual(err.message, 'frozen');
	});

	it('survives an error whose message getter throws', () => {
		const err = Object.defineProperty(new Error('x'), 'message', {
			get() {
				throw new Error('hostile');
			},
			configurable: true,
		});
		assert.doesNotThrow(() => appendErrorContext(err, ' extra'));
	});

	it('ignores values that carry no message', () => {
		assert.doesNotThrow(() => appendErrorContext(undefined, ' extra'));
		assert.doesNotThrow(() => appendErrorContext('a string', ' extra'));
		assert.doesNotThrow(() => appendErrorContext({}, ' extra'));
	});
});

describe('HdbError built from a structured response message', () => {
	const { OP_AUTH_PERMS_ERROR, ROLE_PERMS_ERROR } = hdbErrors.HDB_ERROR_MSGS;
	const SU_ONLY = "Operation 'add_user' is restricted to 'super_user' roles";

	it('has a string message saying what was refused, and keeps the object as its response message', () => {
		const report = new PermissionResponseObject().handleUnauthorizedItem(SU_ONLY);
		const err = handleHDBError(new Error(), report, 403, undefined, false, true);
		assert.strictEqual(err.message, `${OP_AUTH_PERMS_ERROR}: ${SU_ONLY}`);
		assert.strictEqual(err.http_resp_msg, report);
		assert.strictEqual(
			JSON.stringify(err.http_resp_msg),
			JSON.stringify({ error: OP_AUTH_PERMS_ERROR, unauthorized_access: [SU_ONLY], invalid_schema_items: [] })
		);
		assert.strictEqual(String(errorForLog(err)), `HdbError: ${OP_AUTH_PERMS_ERROR}: ${SU_ONLY} statusCode=403`);
	});

	it('renders a table permission failure alongside the invalid items', () => {
		const report = new PermissionResponseObject();
		report.addUnauthorizedTable('dev', 'dog', ['insert']);
		report.addInvalidItem("Table 'dev.cat' does not exist");
		const err = handleHDBError(new Error(), report.getPermsResponse(), 403);
		assert.strictEqual(
			err.message,
			`${OP_AUTH_PERMS_ERROR}: PermissionTableResponseObject { schema: 'dev', table: 'dog', required_table_permissions: [ 'insert' ], required_attribute_permissions: [] }; Table 'dev.cat' does not exist`
		);
	});

	it('describes a role validation report by its error and the problems it lists', () => {
		const report = { error: ROLE_PERMS_ERROR, main_permissions: ["Role can't be blank"], schema_permissions: {} };
		const err = handleHDBError(new Error(), report, 400);
		assert.strictEqual(err.message, `${ROLE_PERMS_ERROR}: Role can't be blank`);
		assert.strictEqual(err.http_resp_msg, report);
	});

	it('uses the error text alone when the report lists nothing else', () => {
		assert.strictEqual(handleHDBError(new Error(), { error: 'Login failed' }, 401).message, 'Login failed');
	});

	it('renders an object with no error text as a whole', () => {
		assert.strictEqual(handleHDBError(new Error(), { blah: 'custom' }, 400).message, "{ blah: 'custom' }");
	});

	it('uses the message of an Error given as the response message', () => {
		assert.strictEqual(handleHDBError(new Error(), new Error("Id can't be blank"), 400).message, "Id can't be blank");
	});

	it('still produces a string for a circular response message', () => {
		const report = { reason: 'loop' };
		report.self = report;
		const err = handleHDBError(new Error(), report, 400);
		assert.strictEqual(typeof err.message, 'string');
		assert.ok(err.message.includes("reason: 'loop'"), err.message);
	});

	it('lists an Error in the response message by its class and message', () => {
		const err = handleHDBError(new Error(), { error: 'Fetch failed', detail: [new Error('upstream refused')] }, 502);
		assert.strictEqual(err.message, 'Fetch failed: Error: upstream refused');
	});

	it('does not expose the properties of an Error nested in the response message', () => {
		const upstream = new Error('upstream refused');
		upstream.config = { headers: { Authorization: 'Bearer super-secret-token' } };
		const err = handleHDBError(new Error(), { error: 'Fetch failed', detail: [upstream] }, 502);
		assert.ok(err.message.startsWith('Fetch failed: '), err.message);
		assert.ok(err.message.includes('upstream refused'), err.message);
		assert.ok(!err.message.includes('super-secret-token'), err.message);
	});

	it('does not throw when reading the response message throws', () => {
		const report = {
			get error() {
				throw new Error('hostile getter');
			},
		};
		const err = handleHDBError(new Error(), report, 403);
		assert.strictEqual(err.http_resp_msg, report);
		assert.strictEqual(typeof err.message, 'string');
	});

	it('does not throw when rendering the response message throws', () => {
		const report = {
			[Symbol.for('nodejs.util.inspect.custom')]() {
				throw new Error('hostile inspector');
			},
		};
		const err = handleHDBError(new Error(), report, 403);
		assert.strictEqual(err.http_resp_msg, report);
		assert.strictEqual(typeof err.message, 'string');
	});

	it('keeps the original error message when there is one', () => {
		assert.strictEqual(handleHDBError(new Error('disk full'), { error: 'Write failed' }, 500).message, 'disk full');
	});

	it('logs the reason rather than [object Object] when the stack is kept', () => {
		const report = new PermissionResponseObject().handleUnauthorizedItem(SU_ONLY);
		const logged = String(errorForLog(handleHDBError(new Error(), report, 400)));
		assert.ok(logged.includes(`${OP_AUTH_PERMS_ERROR}: ${SU_ONLY}`), logged);
		assert.ok(!logged.includes('[object Object]'), logged);
	});
});
