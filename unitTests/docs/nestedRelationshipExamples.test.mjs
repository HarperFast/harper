// Must equal the fixture integrationTests/resources/nested-relationship-docs.test.ts executes; change both together.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const fixture = '../../integrationTests/resources/nested-relationship-docs/';
const examples = JSON.parse(read(fixture + 'examples.json'));
function between(file, start, end) {
	const text = read(file);
	const from = text.indexOf(start);
	const to = text.indexOf(end, from);
	assert(from >= 0 && to > from, `${file} no longer has the section from "${start}" to "${end}"`);
	return text.slice(from, to);
}
const rest = between(
	'../../docs/reference/rest/querying.md',
	'### Filtering and Paging Each Relationship',
	'### Many-to-Many Relationships'
);
const resource = between(
	'../../docs/reference/resources/resource-api.md',
	'#### Constraining related records',
	'### `sort`'
);
const blocks = (source, language) =>
	[...source.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1].trim());
const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function javascriptTokens(source) {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
	const tokens = [];
	while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
	return JSON.stringify(tokens.filter((token, i) => token !== ',' || ![']', '}'].includes(tokens[i + 1]))).slice(1, -1);
}

describe('documented nested relationship examples', () => {
	it('lists every executed REST request and its complete response', () => {
		assert.deepStrictEqual(
			blocks(rest, 'http'),
			examples.cases.map((example) => 'GET ' + example.url)
		);
		assert.deepStrictEqual(
			blocks(rest, 'json').map(JSON.parse),
			examples.cases.map((example) => example.response)
		);
	});

	it('shows the schema the fixture loads', () => {
		assert.strictEqual(normalize(blocks(rest, 'graphql')[0]), normalize(read(fixture + 'schema.graphql')));
	});

	it('shows the seeded brands and products as the sample data', () => {
		const rows = [...rest.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+)\|\s*(p\d+)\s*\|\s*([^|]+)\|\s*(\d+)\s*\|$/gm)];
		assert.deepStrictEqual(
			rows.map((row) => ({ id: row[3], brandId: Number(row[1]), name: row[4].trim(), price: Number(row[5]) })),
			examples.products
		);
		assert.deepStrictEqual(
			[...new Map(rows.map((row) => [Number(row[1]), { id: Number(row[1]), name: row[2].trim() }])).values()],
			examples.brands
		);
	});

	it('shows the programmatic requests the fixture resource runs, and their responses', () => {
		const snippets = blocks(resource, 'javascript');
		assert.strictEqual(snippets.length, 2);
		const source = read(fixture + 'resources.js');
		for (const snippet of snippets) {
			assert(
				javascriptTokens(source).includes(javascriptTokens(snippet)),
				'programmatic snippet drifted from the executable fixture'
			);
		}
		assert.deepStrictEqual(blocks(resource, 'json').map(JSON.parse), [examples.single, examples.programmatic]);
	});
});
