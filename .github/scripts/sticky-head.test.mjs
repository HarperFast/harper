import assert from 'node:assert';
import test from 'node:test';

import { extractRecordedHead, headMarkerLine } from './sticky-head.js';

const SHA = '6245fdffa5e8c5f3e1cbb6df3b2d1b6b5fda1234';

test('extractRecordedHead finds a recorded SHA', () => {
	const body = `<!-- release-cherry-pick:v5.1 -->\n${headMarkerLine(SHA)}\n## stuff\n`;
	assert.strictEqual(extractRecordedHead(body), SHA);
});

test('extractRecordedHead returns null when the marker is absent', () => {
	assert.strictEqual(extractRecordedHead('<!-- release-cherry-pick:v5.1 -->\n## stuff\n'), null);
});

test('extractRecordedHead returns null for an explicitly empty record', () => {
	const body = `<!-- release-cherry-pick:v5.1 -->\n${headMarkerLine('')}\n## stuff\n`;
	assert.strictEqual(extractRecordedHead(body), null);
});

test('extractRecordedHead returns null for non-string input', () => {
	assert.strictEqual(extractRecordedHead(undefined), null);
	assert.strictEqual(extractRecordedHead(null), null);
});

test('headMarkerLine round-trips through extractRecordedHead', () => {
	const line = headMarkerLine(SHA);
	assert.strictEqual(extractRecordedHead(line), SHA);
});
