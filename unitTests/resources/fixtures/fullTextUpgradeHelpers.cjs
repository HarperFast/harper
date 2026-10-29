'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

function previousFullTextProcess(mode, options, documents, payload) {
	try {
		return JSON.parse(
			execFileSync(process.execPath, [path.join(__dirname, 'fullTextUpgradeProcess.cjs')], {
				input: JSON.stringify({ mode, options, documents, payload }),
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
