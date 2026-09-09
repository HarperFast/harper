'use strict';

const assert = require('node:assert');
const { hasOperationScope, attachScopeToToken, attachScopeToUser } = require('#src/security/operationScope');

describe('operationScope', () => {
	describe('hasOperationScope', () => {
		it('is true for any array, including the empty deny-all scope', () => {
			assert.strictEqual(hasOperationScope(['deploy_component']), true);
			assert.strictEqual(hasOperationScope([]), true);
		});

		it('is false for an absent scope', () => {
			for (const value of [undefined, null, 'deploy_component', 42, {}]) {
				assert.strictEqual(hasOperationScope(value), false, `expected false for ${JSON.stringify(value)}`);
			}
		});
	});

	describe('attachScopeToToken', () => {
		it('copies a present scope onto the `operations` claim', () => {
			const payload = { username: 'u', super_user: false };
			assert.strictEqual(attachScopeToToken(payload, ['deploy_component']), payload);
			assert.deepStrictEqual(payload.operations, ['deploy_component']);
		});

		// The fail-closed case this whole feature hinges on: an empty scope means deny-all and must
		// survive, not be treated as "no scope".
		it('preserves an empty deny-all scope', () => {
			const payload = { username: 'u', super_user: false };
			attachScopeToToken(payload, []);
			assert.deepStrictEqual(payload.operations, []);
		});

		it('leaves the payload untouched for an absent scope', () => {
			for (const scope of [undefined, null]) {
				const payload = { username: 'u', super_user: false };
				attachScopeToToken(payload, scope);
				assert.ok(!('operations' in payload), `operations must be absent for ${JSON.stringify(scope)}`);
			}
		});
	});

	describe('attachScopeToUser', () => {
		it('copies a present scope onto `tokenOperations`', () => {
			const user = { username: 'u' };
			assert.strictEqual(attachScopeToUser(user, ['get_status']), user);
			assert.deepStrictEqual(user.tokenOperations, ['get_status']);
		});

		it('preserves an empty deny-all scope', () => {
			const user = { username: 'u' };
			attachScopeToUser(user, []);
			assert.deepStrictEqual(user.tokenOperations, []);
		});

		it('leaves the user untouched for an absent scope', () => {
			const user = { username: 'u' };
			attachScopeToUser(user, undefined);
			assert.ok(!('tokenOperations' in user));
		});
	});
});
