'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const assert = require('node:assert');

const fixture = readFileSync(path.join(__dirname, 'fullTextUpgradeProcess.cjs'), 'utf8');

function previousFullTextProcess(mode, options, documents, payload, version = '0.5.0') {
	const root = process.env.HARPER_FULLTEXT_UPGRADE_ROOT;
	assert(root && path.isAbsolute(root), 'HARPER_FULLTEXT_UPGRADE_ROOT must name an absolute provisioned fixture root');
	assert(['0.5.0', '0.7.0', '0.8.0'].includes(version));
	try {
		return JSON.parse(
			execFileSync(process.execPath, ['--eval', fixture], {
				cwd: path.join(root, version),
				input: JSON.stringify({ mode, options, documents, payload, version }),
				encoding: 'utf8',
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, FULLTEXT_PREFER_LOCAL_BUILD: '' },
			})
		);
	} catch (error) {
		if (error.stderr && !error.message.includes(error.stderr)) error.message += `\n${error.stderr}`;
		throw error;
	}
}

module.exports = { previousFullTextProcess };
