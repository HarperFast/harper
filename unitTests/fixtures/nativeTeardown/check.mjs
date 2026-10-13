import assert from 'node:assert';
import { getDatabases } from '#src/resources/databases';

describe('the next ESM file', () => {
	it('does not inherit the preceding file database', () => {
		assert(!Object.hasOwn(getDatabases(), 'nativeTeardownOwned'));
	});
});
