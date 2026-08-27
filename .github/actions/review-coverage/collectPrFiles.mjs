#!/usr/bin/env node

import { renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 3000;

export async function readBounded(input, maxBytes = MAX_INPUT_BYTES) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of input) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error(`PR-files response exceeds ${maxBytes} bytes`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function normalizePrFiles(pages) {
	if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
		throw new Error('expected --slurp paginated arrays');
	const files = pages.flat();
	if (files.length > MAX_FILES) throw new Error(`PR-files response exceeds ${MAX_FILES} files`);
	return {
		version: 1,
		complete: files.length < MAX_FILES,
		files: files.map((file) => {
			if (!file || typeof file.filename !== 'string') throw new Error('PR-files entry has no filename');
			return {
				path: file.filename,
				patchAvailable: typeof file.patch === 'string',
				ranges: typeof file.patch === 'string' ? parseRanges(file.patch) : { L: [], R: [] },
			};
		}),
	};
}

function parseRanges(patch) {
	const ranges = { L: [], R: [] };
	for (const line of patch.split('\n')) {
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!hunk) continue;
		for (const [side, startIndex, countIndex] of [
			['L', 1, 2],
			['R', 3, 4],
		]) {
			const start = Number(hunk[startIndex]);
			const count = hunk[countIndex] === undefined ? 1 : Number(hunk[countIndex]);
			if (count > 0) ranges[side].push([start, start + count - 1]);
		}
	}
	return ranges;
}

async function main() {
	const output = process.argv[2];
	if (!output) throw new Error('output path is required');
	const normalized = normalizePrFiles(JSON.parse(await readBounded(process.stdin)));
	writeFileSync(`${output}.tmp`, JSON.stringify(normalized));
	renameSync(`${output}.tmp`, output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`collect-pr-files: ${error.message}`);
		process.exitCode = 1;
	});
}
