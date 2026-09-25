'use strict';

/**
 * An operation refused by the permission check, taken through the operations API's own handlers:
 * handlePostRequest, which runs the check, then serverErrorHandler, which Fastify hands the error
 * along with the same request.
 */
const assert = require('assert');
const { existsSync, readFileSync } = require('node:fs');
const logger = require('#src/utility/logging/harper_logger');
const { handleHDBError, hdbErrors } = require('#src/utility/errors/hdbError');
const { server } = require('#src/server/Server');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const opAuth = require('#src/utility/operation_authorization');
const { handlePostRequest, serverErrorHandler } = require('#js/server/serverHelpers/serverHandlers');
const { pinLogConfig } = require('../../logConfigFixture.js');
const { waitFor } = require('../../waitFor.js');

const { OP_AUTH_PERMS_ERROR } = hdbErrors.HDB_ERROR_MSGS;
const notInOperations = (operation) =>
	`Operation '${operation}' is not permitted for this role's operations configuration`;

class RecordedReply {
	code(statusCode) {
		this.statusCode = statusCode;
		return this;
	}
	send(body) {
		this.body = body;
		return this;
	}
}

async function failPostRequest(body) {
	const request = { body };
	const error = await handlePostRequest(request).then(
		() => assert.fail(`${body.operation} did not fail`),
		(failure) => failure
	);
	const reply = new RecordedReply();
	serverErrorHandler(error, request, reply);
	return { error, reply };
}

function refuse(body) {
	// An `operations` allowlist refuses anything the role does not list.
	const hdb_user = {
		username: 'limited',
		active: true,
		role: { role: 'limited', permission: { super_user: false, operations: ['user_info'] } },
	};
	return failPostRequest({ ...body, hdb_user });
}

let markers = 0;

// Logs a marker and waits for it, so every line logged before it has reached the file.
async function linesLoggedSince(offset) {
	const logPath = logger.getLogFilePath();
	const marker = `refused-operation-marker-${++markers}`;
	logger.notify(marker);
	const written = await waitFor(
		() => {
			const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(offset) : '';
			return tail.includes(marker) ? tail : undefined;
		},
		{ message: `${marker} never reached ${logPath}` }
	);
	return written.slice(0, written.indexOf(marker)).split('\n');
}

function logLength() {
	const logPath = logger.getLogFilePath();
	return existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
}

describe('An operation refused by the permission check', function () {
	let restoreLogConfig;

	before(function () {
		restoreLogConfig = pinLogConfig({ level: 'info' });
	});

	after(function () {
		restoreLogConfig?.();
	});

	it('answers 403 with the permission report, unchanged, as the body', async function () {
		const { error, reply } = await refuse({ operation: 'list_users' });
		assert.strictEqual(reply.statusCode, 403);
		assert.strictEqual(reply.body, error.http_resp_msg);
		assert.strictEqual(
			JSON.stringify(reply.body),
			JSON.stringify({
				error: OP_AUTH_PERMS_ERROR,
				unauthorized_access: [notInOperations('list_users')],
				invalid_schema_items: [],
			})
		);
	});

	it('is logged once, with the reason it was refused', async function () {
		const offset = logLength();
		await refuse({ operation: 'add_user', role: 'limited', username: 'someone', password: 'pw', active: true });
		const lines = await linesLoggedSince(offset);
		const reasonLines = lines.filter((line) => line.includes(`${OP_AUTH_PERMS_ERROR}: ${notInOperations('add_user')}`));
		assert.strictEqual(reasonLines.length, 1, lines.join('\n'));
		assert.ok(reasonLines[0].includes('[error]'), reasonLines[0]);
		assert.ok(!lines.some((line) => line.includes('[object Object]')), lines.join('\n'));
	});

	// serverErrorHandler alone would log this at info, below the default level.
	it('keeps the error-level line for an operation error without a log level of its own', async function () {
		const offset = logLength();
		const { error } = await failPostRequest(JSON.parse('{"operation": "user_info", "__proto__": {}}'));
		assert.strictEqual(error.logLevel, undefined);
		const lines = (await linesLoggedSince(offset)).filter((line) => line.includes(error.message));
		assert.strictEqual(lines.length, 1, lines.join('\n'));
		assert.ok(lines[0].includes('[error]'), lines[0]);
	});

	it('leaves an error raised outside handlePostRequest to serverErrorHandler to log', async function () {
		const offset = logLength();
		const message = 'Request body must include an operation (refused-operation test)';
		serverErrorHandler(handleHDBError(new Error(), message, 400), { body: {} }, new RecordedReply());
		const lines = (await linesLoggedSince(offset)).filter((line) => line.includes(message));
		assert.strictEqual(lines.length, 1, lines.join('\n'));
	});

	it('still logs an error object that another request already logged', async function () {
		const offset = logLength();
		const { error } = await refuse({ operation: 'list_roles' });
		serverErrorHandler(error, { body: {} }, new RecordedReply());
		const lines = (await linesLoggedSince(offset)).filter((line) => line.includes(notInOperations('list_roles')));
		assert.strictEqual(lines.length, 2, lines.join('\n'));
	});
});

describe('An operation error raised above error level', function () {
	const OPERATION = 'refused_operation_test_fatal';
	const MESSAGE = 'refused-operation fatal failure';
	let restoreLogConfig;

	before(function () {
		restoreLogConfig = pinLogConfig({ level: 'fatal' });
		server.registerOperation({
			name: OPERATION,
			execute: () => {
				throw handleHDBError(new Error(MESSAGE), undefined, 500, 'fatal');
			},
			requiresSuperUser: true,
		});
	});

	after(function () {
		serverUtilities.OPERATION_FUNCTION_MAP.delete(OPERATION);
		opAuth.unregisterOperationPermission(OPERATION);
		restoreLogConfig?.();
	});

	it('is logged once at its own level, so a fatal-only log still shows it', async function () {
		const offset = logLength();
		await failPostRequest({
			operation: OPERATION,
			hdb_user: { username: 'admin', active: true, role: { role: 'admin', permission: { super_user: true } } },
		});
		const lines = (await linesLoggedSince(offset)).filter((line) => line.includes(MESSAGE));
		assert.strictEqual(lines.length, 1, lines.join('\n'));
		assert.ok(lines[0].includes('[fatal]'), lines[0]);
	});
});
