'use strict';

const assert = require('assert');
const sinon = require('sinon');
const { promisify } = require('node:util');
const sandbox = sinon.createSandbox();

const sqlTranslator = require('#src/sqlTranslator/index');
const opAuth = require('#src/utility/operation_authorization');
const sqlEngineRouter = require('#src/sqlEngine/router');
const operationAuthorizationState = require('#src/server/serverHelpers/operationAuthorizationState');
const PermissionResponseObject = require('#src/security/data_objects/PermissionResponseObject').default;

// verifyPermsAST denies with a PermissionResponseObject. Stubbing an array would also satisfy a
// guard that tests `.length`, so these stubs have to use the real shape to pin the guard at all.
function denial() {
	return new PermissionResponseObject().handleUnauthorizedItem('denied');
}

describe('sqlTranslator processAST authorization bypass state (GHSA-7h8h-wq7f-qx65)', function () {
	afterEach(function () {
		sandbox.restore();
	});

	it('ignores a caller-supplied jsonMessage.bypass_auth and still enforces AST permissions', function (done) {
		sandbox.stub(opAuth, 'verifyPermsAST').returns(denial());
		const routeStub = sandbox.stub(sqlEngineRouter, 'route').callsFake((_options, cb) => cb(null, []));

		sqlTranslator.evaluateSQL(
			{ sql: 'SELECT * FROM dev.dog', hdb_user: { username: 'nobody' }, bypass_auth: true },
			(err) => {
				try {
					assert.strictEqual(err, 403);
					assert.strictEqual(routeStub.called, false);
					done();
				} catch (e) {
					done(e);
				}
			}
		);
	});

	it('honors the trusted dispatch-context bypass regardless of body state', async function () {
		sandbox.stub(opAuth, 'verifyPermsAST').returns(denial());
		const routeStub = sandbox.stub(sqlEngineRouter, 'route').callsFake((_opts, cb) => cb(null, []));

		// Wrap evaluateSQL's callback in a promise and await the run() call (rather than calling
		// done() from inside a bare callback) so the ALS context is exited via the same
		// promise-chain idiom used elsewhere (differential.ts, operationExecuteRequestHandler) —
		// a synchronous callback with no returned promise can leak the bypass context into
		// whatever mocha schedules next.
		const err = await operationAuthorizationState.runWithOperationAuthorizationBypass(
			true,
			() =>
				new Promise((resolve) => {
					sqlTranslator.evaluateSQL({ sql: 'SELECT * FROM dev.dog', hdb_user: { username: 'nobody' } }, (err) =>
						resolve(err)
					);
				})
		);

		assert.strictEqual(err, null);
		assert.strictEqual(routeStub.called, true);
	});
});

describe('sqlTranslator processAST permission denial', function () {
	// Real roles rather than a stubbed verifyPermsAST: a stub asserting the denial was *computed* is
	// how a dead consumer went unnoticed in the first place. A role with no table permissions cannot
	// read dev.dog, so verifyPermsAST returns a real PermissionResponseObject.
	function userWithRole(permission) {
		return { username: 'restricted', role: { role: '_processAST_test', permission } };
	}

	/** Resolved rather than asserted inside: processAST wraps its body in try/catch, so an assertion
	 * thrown in the callback would be swallowed and re-reported as a second invocation. */
	function runProcessAST(jsonMessage, mutateParsed) {
		const parsedSqlObject = sqlTranslator.convertSQLToAST(jsonMessage.sql);
		if (mutateParsed) mutateParsed(parsedSqlObject);
		return new Promise((resolve) => {
			sqlTranslator.processAST(jsonMessage, parsedSqlObject, (error, results) => resolve({ error, results }));
		});
	}

	it('refuses a statement the permission check denied', async function () {
		const { error, results } = await runProcessAST({
			operation: 'sql',
			sql: 'SELECT * FROM dev.dog',
			hdb_user: userWithRole({ super_user: false }),
		});

		assert.strictEqual(error, 403, 'a denied statement must come back unauthorized');
		assert.ok(results?.unauthorized_access, 'expected the permission response, not a result set');
	});

	// The response object is what a caller renders, so processAST has to hand it back rather than
	// collapse it into the status. evaluateSQL is the layer that drops it (see the promisify case).
	it('forwards the response object rather than collapsing it into the status', async function () {
		const { results } = await runProcessAST({
			operation: 'sql',
			sql: 'DELETE FROM dev.dog',
			hdb_user: userWithRole({ super_user: false }),
		});

		assert.ok(results.error, 'expected the response object to carry its error message');
	});

	// The other direction: this must not begin refusing what was always permitted. verifyPermsAST
	// returns null for a super_user, so the branch falls through as before.
	it('does not interfere when the permission check allows the statement', async function () {
		const { error } = await runProcessAST({
			operation: 'sql',
			sql: 'SELECT * FROM dev.dog',
			hdb_user: userWithRole({ super_user: true }),
		});

		assert.notStrictEqual(error, 403, 'an authorized statement must not be refused');
	});

	// promisify turns the denial into a rejection whose reason is the bare number, because evaluateSQL
	// drops its second callback argument on error. A job worker records that as its failure message,
	// so the status is all an operator sees. Preserved rather than changed: evaluateSQL's error
	// contract is shared with every other caller.
	it('rejects with the bare status through promisified evaluateSQL', async function () {
		await assert.rejects(
			promisify(sqlTranslator.evaluateSQL)({
				operation: 'sql',
				sql: 'SELECT * FROM dev.dog',
				hdb_user: userWithRole({ super_user: false }),
			}),
			(reason) => reason === 403
		);
	});

	it('skips the check when an earlier gate already verified the statement', async function () {
		const { error } = await runProcessAST(
			{ operation: 'sql', sql: 'SELECT * FROM dev.dog', hdb_user: userWithRole({ super_user: false }) },
			(parsed) => {
				parsed.permissions_checked = true;
			}
		);

		assert.notStrictEqual(error, 403, 'a pre-checked statement must not be re-denied here');
	});
});
