const assert = require('node:assert');
const { Resource } = require('#src/resources/Resource');

// #1922: URL attribute-suffix routing (/id.attr) resolves attributes via `this.attributes`. A
// programmatic Resource may declare `static properties` (a Record keyed by attribute name) without
// an `attributes` Array, so the suffix must also be looked up there — an O(1) key check, no
// per-request projection.
describe('Resource.parsePath attribute-suffix routing (#1922)', () => {
	class ProgrammaticWidget extends Resource {
		static properties = {
			label: { type: 'string' },
			size: { type: 'integer' },
		};
	}

	it('routes /id.attr to a static-properties attribute (no attributes Array)', () => {
		assert.strictEqual(ProgrammaticWidget.attributes, undefined, 'precondition: no attributes Array');
		const query = {};
		const result = ProgrammaticWidget.parsePath('123.label', {}, query);
		assert.strictEqual(result, '123', 'the attribute suffix is stripped from the path');
		assert.strictEqual(query.property, 'label', 'the attribute is bound onto the query');
	});

	it('returns { property, id } when no query object is provided', () => {
		const result = ProgrammaticWidget.parsePath('123.size', {});
		assert.deepStrictEqual(result, { property: 'size', id: '123' });
	});

	it('leaves an unknown suffix untouched', () => {
		const query = {};
		const result = ProgrammaticWidget.parsePath('123.nope', {}, query);
		assert.strictEqual(result, '123.nope', 'a non-attribute suffix is not treated as an attribute');
		assert.strictEqual(query.property, undefined);
	});

	it('does not treat inherited Object.prototype members as attributes', () => {
		// `properties['constructor']` would be truthy via the prototype chain; the own-key check must
		// reject it so /id.constructor (etc.) is not mistaken for an attribute suffix.
		for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
			const query = {};
			const result = ProgrammaticWidget.parsePath(`123.${proto}`, {}, query);
			assert.strictEqual(result, `123.${proto}`, `${proto} must not be treated as an attribute`);
			assert.strictEqual(query.property, undefined);
		}
	});
});
