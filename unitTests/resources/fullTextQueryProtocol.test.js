const assert = require('node:assert');
const { serialize } = require('node:v8');
const { fullTextPageResponseBytes } = require('#src/resources/indexes/fullTextQueryProtocol');

describe('full-text page response bounds', () => {
	it('bounds structured-clone replies for ASCII, Latin-1, multibyte and supplementary text', () => {
		for (const text of ['x', 'é', 'Ω', '界', '😀', '\ud800', 'x'.repeat(4094) + 'Ω', 'x'.repeat(4092) + '😀']) {
			const maximumString = text.repeat(Math.floor(4096 / Buffer.byteLength(text)));
			const page = {
				total: Number.MAX_SAFE_INTEGER,
				totalRelation: 'lower-bound',
				continuation: maximumString,
				hits: Array.from({ length: 1000 }, (_, index) => ({
					id: `i${String(index).padStart(3, '0')}${maximumString.slice(4)}`,
					version: `v${String(index).padStart(3, '0')}${maximumString.slice(4)}`,
					score: Number.MAX_VALUE,
				})),
			};
			const reply = { id: 'a'.repeat(32), originator: Number.MAX_SAFE_INTEGER, value: page };
			assert(fullTextPageResponseBytes(page) >= serialize(reply).byteLength, text);
		}
	});
});
