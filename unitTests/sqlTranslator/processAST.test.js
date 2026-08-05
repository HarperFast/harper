'use strict';

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const sqlTranslator = require('#src/sqlTranslator/index');
const opAuth = require('#src/utility/operation_authorization');
const sqlEngineRouter = require('#src/sqlEngine/router');
const operationAuthorizationState = require('#src/server/serverHelpers/operationAuthorizationState');

describe('sqlTranslator processAST authorization bypass state (GHSA-7h8h-wq7f-qx65)', function () {
	afterEach(function () {
		sandbox.restore();
	});

	it('ignores a caller-supplied jsonMessage.bypass_auth and still enforces AST permissions', function (done) {
		sandbox.stub(opAuth, 'verifyPermsAST').returns(['denied']);
		const routeStub = sandbox.stub(sqlEngineRouter, 'route');

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
		sandbox.stub(opAuth, 'verifyPermsAST').returns(['denied']);
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
