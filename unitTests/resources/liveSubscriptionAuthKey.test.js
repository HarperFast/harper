'use strict';

const assert = require('node:assert');
const {
	_liveSubscriptionAuthKeyForTest: liveSubscriptionAuthKey,
	_canonicalTargetKeyForTest: canonicalKey,
} = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');

// resources whose read authorization depends only on the user and the target, as a table's own does
class ResourceA {
	static readAuthorizationIgnoresContext() {
		return true;
	}
}
class ResourceB extends ResourceA {}
const resourceA = new ResourceA();
const resourceB = new ResourceB();

// the key reads the username from the subscribing context
const authKey = (resource, username, requestTarget) =>
	liveSubscriptionAuthKey(resource, username === undefined ? {} : { user: { username } }, requestTarget);

function target(url, props = {}) {
	const requestTarget = new RequestTarget(url);
	Object.assign(requestTarget, props);
	return requestTarget;
}

describe('liveSubscriptionAuthKey', () => {
	it('is stable for identical admissions', () => {
		const a = authKey(resourceA, 'u1', target('/Msg/topic1', { isCollection: false, startTime: 5 }));
		const b = authKey(resourceA, 'u1', target('/Msg/topic1', { isCollection: false, startTime: 5 }));
		assert.ok(a != null);
		assert.equal(a, b);
	});

	it('is insensitive to property assignment order', () => {
		const a = authKey(resourceA, 'u1', target('/Msg/t', { startTime: 5, omitCurrent: true }));
		const b = authKey(resourceA, 'u1', target('/Msg/t', { omitCurrent: true, startTime: 5 }));
		assert.equal(a, b);
	});

	it('discriminates by target path, query string, user, and resource class', () => {
		const base = () => target('/Msg/topic1');
		const key = authKey(resourceA, 'u1', base());
		assert.notEqual(authKey(resourceA, 'u1', target('/Msg/topic2')), key);
		assert.notEqual(authKey(resourceA, 'u1', target('/Msg/topic1?limit=5')), key);
		assert.notEqual(authKey(resourceA, 'u2', base()), key);
		assert.notEqual(authKey(resourceB, 'u1', base()), key);
	});

	it('discriminates by assigned scalar and structured properties', () => {
		const key = authKey(resourceA, 'u1', target('/Msg/t', { startTime: 5 }));
		assert.notEqual(authKey(resourceA, 'u1', target('/Msg/t', { startTime: 6 })), key);
		assert.notEqual(authKey(resourceA, 'u1', target('/Msg/t', { startTime: 5, onlyChildren: true })), key);
		const withConditions = (value) =>
			authKey(resourceA, 'u1', target('/Msg/t', { conditions: [{ attribute: 'a', value }] }));
		assert.equal(withConditions(1), withConditions(1));
		assert.notEqual(withConditions(1), withConditions(2));
	});

	it('ignores checkPermission — it is role-derived, not part of the admission identity', () => {
		const a = authKey(resourceA, 'u1', target('/Msg/t', { checkPermission: { super_user: true } }));
		const b = authKey(resourceA, 'u1', target('/Msg/t', { checkPermission: { tables: {} } }));
		assert.equal(a, b);
	});

	it('a username containing the separator cannot collide across segment boundaries', () => {
		const a = authKey(resourceA, 'u1|x', target('/Msg/t'));
		const b = authKey(resourceA, 'u1', target('x|/Msg/t'));
		assert.notEqual(a, b);
	});

	it('returns null without a username', () => {
		assert.equal(authKey(resourceA, undefined, target('/Msg/t')), null);
		assert.equal(authKey(resourceA, '', target('/Msg/t')), null);
	});

	it('returns null for a resource whose read authorization may depend on the context', () => {
		class ContextSensitive {
			static readAuthorizationIgnoresContext() {
				return false;
			}
		}
		class Undeclared {}
		assert.equal(authKey(new ContextSensitive(), 'u1', target('/Msg/t')), null);
		assert.equal(authKey(new Undeclared(), 'u1', target('/Msg/t')), null);
	});

	it('returns null for targets carrying reference-identity values', () => {
		assert.equal(authKey(resourceA, 'u1', target('/Msg/t', { rowFilter: () => true })), null);
		assert.equal(authKey(resourceA, 'u1', target('/Msg/t', { custom: new Date() })), null);
		const circular = {};
		circular.self = circular;
		assert.equal(authKey(resourceA, 'u1', target('/Msg/t', { circular })), null);
	});
});

describe('canonicalTargetKey', () => {
	it('canonicalizes primitives, arrays, and nested plain objects', () => {
		const a = canonicalKey(target('/Msg/t', { id: ['a', 1], nested: { x: null, y: undefined, z: false } }));
		const b = canonicalKey(target('/Msg/t', { nested: { z: false, y: undefined, x: null }, id: ['a', 1] }));
		assert.ok(a != null);
		assert.equal(a, b);
	});

	it('returns null for an array with a property besides its elements, or a hole', () => {
		const select = ['name'];
		select.asArray = true;
		assert.equal(canonicalKey(target('/Msg/t', { select })), null);
		assert.equal(canonicalKey(target('/Msg/t', { select: ['name', , 'id'] })), null); // eslint-disable-line no-sparse-arrays
		// as many extra properties as holes still is not just its elements
		const balanced = ['name', , 'id']; // eslint-disable-line no-sparse-arrays
		balanced.extra = true;
		assert.equal(canonicalKey(target('/Msg/t', { select: balanced })), null);
		assert.notEqual(canonicalKey(target('/Msg/t', { select: ['name'] })), null);
	});

	it('returns null for non-object input', () => {
		assert.equal(canonicalKey(null), null);
		assert.equal(canonicalKey('string'), null);
	});

	it('distinguishes value types that stringify alike', () => {
		assert.notEqual(canonicalKey(target('/Msg/t', { value: 1 })), canonicalKey(target('/Msg/t', { value: '1' })));
		assert.notEqual(canonicalKey(target('/Msg/t', { value: null })), canonicalKey(target('/Msg/t', { value: 'null' })));
		assert.notEqual(canonicalKey(target('/Msg/t', { value: 1 })), canonicalKey(target('/Msg/t', { value: 1n })));
	});
});
