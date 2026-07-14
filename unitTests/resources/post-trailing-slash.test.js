// harper#678: POSTing to a Resource path missing its required trailing slash (or with a trailing
// slash plus a bogus path segment) used to surface as an unhandled `Cannot read properties of
// undefined/null (reading 'query')` TypeError instead of a clean HTTP error. Root cause: matching a
// resource's exact base path with nothing left to parse produced a `RequestTarget` with BOTH `id`
// and `isCollection` left `undefined` (an unreachable-by-design state distinct from the well-formed
// `/` collection target, where they're `null`/`true`). Downstream dispatch/permission code that
// assumed one of the two was always set could crash on that undefined state.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');

describe('RequestTarget — matched-path invariants (harper#678)', () => {
	it('leaves id/isCollection unset only for a truly argument-less construction (internal use)', () => {
		const target = new RequestTarget();
		assert.strictEqual(target.id, undefined);
		assert.strictEqual(target.isCollection, undefined);
	});

	it('an exact resource-path match with no trailing slash is a well-defined non-collection, non-id state', () => {
		// mirrors `new RequestTarget(entry.relativeURL)` in server/REST.ts when getMatch() returns
		// relativeURL === '' (the request path had no trailing slash and nothing left to parse)
		const target = new RequestTarget('');
		assert.strictEqual(target.id, null);
		assert.strictEqual(target.isCollection, false);
	});

	it('a bare trailing slash is still the well-formed collection target', () => {
		const target = new RequestTarget('/');
		assert.strictEqual(target.id, null);
		assert.strictEqual(target.isCollection, true);
	});

	it('a trailing segment past the matched resource still resolves to a specific id', () => {
		const target = new RequestTarget('/hi');
		assert.strictEqual(target.id, 'hi');
		assert.ok(!target.isCollection);
	});
});

describe('POST dispatch — missing trailing slash / bogus segment (harper#678)', () => {
	let PostTrailingSlash;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		PostTrailingSlash = table({
			table: 'PostTrailingSlash',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'String', isPrimaryKey: true },
				{ name: 'value', type: 'String' },
			],
		});
	});

	it('returns a clean 404 (not an unhandled exception) when POSTed without the required trailing slash', async () => {
		const target = new RequestTarget(''); // e.g. POST /PostTrailingSlash (no trailing slash)
		await assert.rejects(
			async () => PostTrailingSlash.post(target, { value: 'x' }, {}),
			(error) => {
				assert.strictEqual(error.statusCode, 404);
				assert.match(error.message, /trailing slash/i);
				return true;
			}
		);
	});

	it('returns a clean error (not an unhandled exception) for a trailing slash plus a bogus segment', async () => {
		const target = new RequestTarget('/this-id-does-not-exist'); // e.g. POST /PostTrailingSlash/this-id-does-not-exist
		await assert.rejects(
			async () => PostTrailingSlash.post(target, { value: 'x' }, {}),
			(error) => {
				assert.ok(
					error.statusCode === 404 || error.statusCode === 405,
					`expected a clean 4xx, got ${error.statusCode}`
				);
				return true;
			}
		);
	});

	it('leaves a well-formed collection POST unaffected', async () => {
		const target = new RequestTarget('/');
		const id = await PostTrailingSlash.post(target, { value: 'well-formed' }, {});
		assert.ok(id, 'expected a new record id to be returned');
		assert.equal((await PostTrailingSlash.get(id)).value, 'well-formed');
	});

	it('still returns the table "describe" metadata for GET without a trailing slash (no regression)', async () => {
		const target = new RequestTarget('');
		const resource = await Promise.resolve(PostTrailingSlash.getResource(target, {}));
		const description = await resource.get(target);
		assert.equal(description.name, 'PostTrailingSlash');
		assert.ok(Array.isArray(description.attributes));
	});
});
