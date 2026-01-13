'use strict';
const assert = require('assert');

const { Headers, appendHeader, mergeHeaders } = require('#src/server/serverHelpers/Headers');
describe('Test Headers', () => {
	describe(`Create and modify headers`, function () {
		it('should handle headers', async function () {
			const headers = new Headers();
			assert.equal(Array.from(headers).length, 0);
			assert.equal(headers.get('NaMe'), undefined);
			assert.equal(headers.has('NaMe'), false);
			headers.set('nAmE', 'value');
			assert.equal(headers.get('NaMe'), 'value');
			assert.equal(headers.has('NaMe'), true);
			headers.setIfNone('name', 'value changed');
			assert.equal(headers.get('NaMe'), 'value');
			assert.equal(headers.has('NAME'), true);
			headers.append('naMe', 'value2');
			assert.deepEqual(headers.get('NaMe'), ['value', 'value2']);
			assert.equal(Array.from(headers).length, 1);

			// Test set() with non-string, non-array value
			headers.set('X-Number', 123);
			assert.equal(headers.get('X-Number'), '123');
			assert.equal(typeof headers.get('X-Number'), 'string');

			// Test append() to existing array - exercises the early return path
			headers.set('X-Array', ['value1', 'value2']);
			headers.append('X-Array', 'value3');
			const arrayValue = headers.get('X-Array');
			assert.ok(Array.isArray(arrayValue));
			assert.equal(arrayValue.length, 3);
			assert.equal(arrayValue[2], 'value3');

			// Test setIfNone with non-string value
			headers.setIfNone('X-NewNumber', 456);
			assert.equal(headers.get('X-NewNumber'), '456');

			// Test append with non-string value
			headers.append('X-Numbers', 789);
			assert.equal(headers.get('X-Numbers'), '789');

			// Test methods with non-string name parameter
			headers.set(123, 'value-for-number-name');
			assert.equal(headers.get(123), 'value-for-number-name');
			assert.equal(headers.get('123'), 'value-for-number-name');
			assert.ok(headers.has(123));

			headers.setIfNone(456, 'another-value');
			assert.equal(headers.get(456), 'another-value');

			headers.append(789, 'appended-value');
			assert.equal(headers.get(789), 'appended-value');
		});
		it('should handle append with commas', async function () {
			const headers = new Headers();
			headers.append('name-with-commas', 'value', true);
			headers.append('name-with-commas', 'value2', true);
			appendHeader(headers, 'name-with-commas', 'value3', true);
			assert.equal(headers.get('name-with-commas'), 'value, value2, value3');

			// Test comma-delimited append when existing value is already an array
			headers.set('Accept', ['text/html', 'application/json']);
			headers.append('Accept', 'text/plain', true);
			assert.equal(headers.get('Accept'), 'text/html, application/json, text/plain');
		});
		it('should handle append with commas on a Map', async function () {
			const headers = new Map();
			appendHeader(headers, 'name-with-commas', 'value', true);
			appendHeader(headers, 'name-with-commas', 'value2', true);
			appendHeader(headers, 'name-with-commas', 'value3', true);
			assert.equal(headers.get('name-with-commas'), 'value, value2, value3');
		});
		it('construct headers from object', async function () {
			const headers = new Headers({ name: 'value', name2: 'value2' });
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
		});
		it('construct headers from Map and merge', async function () {
			let map = new Map();
			map.set('name', 'value');
			map.set('name2', 'value2');
			let headers = new Headers(map);
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
			headers = mergeHeaders(headers, new Headers({ name2: 'value3', name3: 'value4' }));
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
			assert.equal(headers.get('name3'), 'value4');
		});
		it('should handle multiple Set-Cookie headers correctly', async function () {
			const headers = new Headers();
			headers.append('Set-Cookie', 'session=abc123');
			headers.append('Set-Cookie', 'user=john');

			// Verify internal storage
			assert.deepEqual(headers.get('Set-Cookie'), ['session=abc123', 'user=john']);

			// Verify serialization - should return ONE entry with an array value
			// Node.js setHeader() will handle the array and create multiple Set-Cookie headers
			const serialized = Array.from(headers);
			assert.equal(serialized.length, 1, 'Should have 1 header entry with array value');
			assert.deepEqual(serialized[0], ['Set-Cookie', ['session=abc123', 'user=john']]);
		});
		it('should keep non-Set-Cookie headers with arrays merged (not split)', async function () {
			const headers = new Headers();
			// Other headers with multiple values should stay as arrays (to be comma-separated)
			headers.append('Accept', 'text/html');
			headers.append('Accept', 'application/json');
			headers.append('Set-Cookie', 'session=abc');
			headers.append('Set-Cookie', 'user=john');

			const serialized = Array.from(headers);

			// Accept should be a single entry with an array value
			const acceptHeaders = serialized.filter(([name]) => name === 'Accept');
			assert.equal(acceptHeaders.length, 1, 'Accept should be a single entry');
			assert.deepEqual(acceptHeaders[0], ['Accept', ['text/html', 'application/json']]);

			// Set-Cookie should also be a single entry with an array value
			const setCookies = serialized.filter(([name]) => name === 'Set-Cookie');
			assert.equal(setCookies.length, 1, 'Set-Cookie should be 1 entry with array value');
			assert.deepEqual(setCookies[0], ['Set-Cookie', ['session=abc', 'user=john']]);
		});
		it('should handle set() with array values and ensure array elements are strings', async function () {
			const headers = new Headers();
			// Set with an array value directly
			headers.set('Set-Cookie', ['cookie1=value1', 'cookie2=value2']);

			// Verify the value is stored as an array with string elements
			const value = headers.get('Set-Cookie');
			assert.ok(Array.isArray(value), 'Value should be an array');
			assert.equal(value.length, 2, 'Array should have 2 elements');
			assert.equal(typeof value[0], 'string', 'First element should be a string');
			assert.equal(typeof value[1], 'string', 'Second element should be a string');
			assert.equal(value[0], 'cookie1=value1');
			assert.equal(value[1], 'cookie2=value2');

			// Test with non-string array elements (like numbers)
			headers.set('X-Custom', [123, 456]);
			const customValue = headers.get('X-Custom');
			assert.ok(Array.isArray(customValue), 'Value should be an array');
			assert.equal(typeof customValue[0], 'string', 'First element should be converted to string');
			assert.equal(typeof customValue[1], 'string', 'Second element should be converted to string');
			assert.equal(customValue[0], '123');
			assert.equal(customValue[1], '456');
		});
		it('should handle appendHeader with headers.set path (no append method)', async function () {
			// Create a plain object with get/set methods but no append
			const headers = {
				values: {},
				get(name) {
					return this.values[name.toLowerCase()];
				},
				set(name, value) {
					this.values[name.toLowerCase()] = value;
				},
			};

			// Test comma-delimited append via headers.set
			appendHeader(headers, 'Accept', 'text/html', true);
			appendHeader(headers, 'Accept', 'application/json', true);
			assert.equal(headers.get('Accept'), 'text/html, application/json');

			// Test non-comma-delimited append with arrays
			appendHeader(headers, 'Set-Cookie', 'cookie1=value1', false);
			appendHeader(headers, 'Set-Cookie', 'cookie2=value2', false);
			const cookies = headers.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 2);
			assert.equal(cookies[0], 'cookie1=value1');
			assert.equal(cookies[1], 'cookie2=value2');

			// Test appending to existing array
			appendHeader(headers, 'Set-Cookie', 'cookie3=value3', false);
			const cookies2 = headers.get('Set-Cookie');
			assert.equal(cookies2.length, 3);
			assert.equal(cookies2[2], 'cookie3=value3');

			// Test comma-delimited append when existing is an array
			headers.set('Accept', ['text/html', 'application/json']);
			appendHeader(headers, 'Accept', 'text/plain', true);
			assert.equal(headers.get('Accept'), 'text/html, application/json, text/plain');
		});
		it('should handle appendHeader with plain object (no set or append)', async function () {
			const headers = {};

			appendHeader(headers, 'X-Custom', 'value1');
			assert.equal(headers['X-Custom'], 'value1');

			appendHeader(headers, 'X-Custom', 'value2');
			assert.equal(headers['X-Custom'], 'value1, value2');

			appendHeader(headers, 'X-Another', 'test');
			assert.equal(headers['X-Another'], 'test');
		});
		it('should handle mergeHeaders with Set-Cookie on target without append method', async function () {
			// Create a target Map (has set/get but no append)
			const target = new Map();
			target.set('existing', 'value');
			target.set('Set-Cookie', 'existing-cookie=value');

			// Source with Set-Cookie headers
			const source = new Headers();
			source.append('Set-Cookie', 'new-cookie1=value1');
			source.append('Set-Cookie', 'new-cookie2=value2');
			source.set('X-Custom', 'test');

			const result = mergeHeaders(target, source);

			// X-Custom should not overwrite existing (mergeHeaders doesn't overwrite)
			assert.equal(result.get('existing'), 'value');

			// X-Custom should be added (didn't exist in target)
			assert.equal(result.get('X-Custom'), 'test');

			// Set-Cookie should merge the arrays
			const cookies = result.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 3, 'Should have all 3 cookies');
			assert.equal(cookies[0], 'existing-cookie=value');
			assert.equal(cookies[1], 'new-cookie1=value1');
			assert.equal(cookies[2], 'new-cookie2=value2');
		});
		it('should handle mergeHeaders with Set-Cookie on target with append method', async function () {
			// Create a target Headers object (has append method)
			const target = new Headers();
			target.set('Existing', 'value');
			target.set('Set-Cookie', 'existing-cookie=value');

			// Source with Set-Cookie headers
			const source = new Headers();
			source.append('Set-Cookie', 'new-cookie1=value1');
			source.append('Set-Cookie', 'new-cookie2=value2');
			source.set('X-Custom', 'test');

			const result = mergeHeaders(target, source);

			// Existing should not be overwritten
			assert.equal(result.get('Existing'), 'value');

			// X-Custom should be added
			assert.equal(result.get('X-Custom'), 'test');

			// Set-Cookie should merge via append
			const cookies = result.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 3, 'Should have all 3 cookies');
			assert.equal(cookies[0], 'existing-cookie=value');
			assert.equal(cookies[1], 'new-cookie1=value1');
			assert.equal(cookies[2], 'new-cookie2=value2');
		});
		it('should handle mergeHeaders with plain object target', async function () {
			// Plain object without set/has methods - should be converted to Headers
			const target = { 'X-Existing': 'value' };

			const source = new Headers();
			source.set('X-New', 'test');

			const result = mergeHeaders(target, source);

			// Result should be a Headers object
			assert.ok(result.get);
			assert.ok(result.has);
			assert.equal(result.get('X-New'), 'test');
		});
		it('should handle mergeHeaders with single Set-Cookie value (not array)', async function () {
			// Target with single Set-Cookie value
			const target = new Headers();
			target.set('Set-Cookie', 'existing-cookie=value');

			// Source with single Set-Cookie value (not an array)
			const source = new Headers();
			source.set('Set-Cookie', 'new-cookie=value');

			const result = mergeHeaders(target, source);

			const cookies = result.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 2);
			assert.equal(cookies[0], 'existing-cookie=value');
			assert.equal(cookies[1], 'new-cookie=value');
		});
		it('should handle mergeHeaders with Map target and single existing Set-Cookie', async function () {
			// Map target with single Set-Cookie value (not array)
			const target = new Map();
			target.set('Set-Cookie', 'existing-cookie=value');

			// Source with Set-Cookie array
			const source = new Headers();
			source.append('Set-Cookie', 'new-cookie1=value1');
			source.append('Set-Cookie', 'new-cookie2=value2');

			const result = mergeHeaders(target, source);

			// Should merge single value with array values
			const cookies = result.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 3);
			assert.equal(cookies[0], 'existing-cookie=value');
			assert.equal(cookies[1], 'new-cookie1=value1');
			assert.equal(cookies[2], 'new-cookie2=value2');
		});
		it('should handle mergeHeaders with Map target and array existing Set-Cookie', async function () {
			// Map target with array Set-Cookie value
			const target = new Map();
			target.set('Set-Cookie', ['existing-cookie1=value1', 'existing-cookie2=value2']);

			// Source with Set-Cookie array
			const source = new Headers();
			source.append('Set-Cookie', 'new-cookie1=value1');
			source.append('Set-Cookie', 'new-cookie2=value2');

			const result = mergeHeaders(target, source);

			// Should merge arrays together
			const cookies = result.get('Set-Cookie');
			assert.ok(Array.isArray(cookies), 'Should be an array');
			assert.equal(cookies.length, 4);
			assert.equal(cookies[0], 'existing-cookie1=value1');
			assert.equal(cookies[1], 'existing-cookie2=value2');
			assert.equal(cookies[2], 'new-cookie1=value1');
			assert.equal(cookies[3], 'new-cookie2=value2');
		});
		it('should verify mergeHeaders returns the same target (modifies in place)', async function () {
			const target = new Headers();
			target.set('Existing', 'value');

			const source = new Headers();
			source.set('X-New', 'test');

			const result = mergeHeaders(target, source);

			// Verify result is the same object as target (modified in place)
			assert.strictEqual(result, target, 'mergeHeaders should return the same target object');
			assert.equal(target.get('X-New'), 'test', 'target should be modified in place');
		});
	});
});
