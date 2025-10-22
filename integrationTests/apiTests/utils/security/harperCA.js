#!/usr/bin/env node

/**
 * Shared utilities for working with Harper's Certificate Authority
 * Used by both OCSP and CRL testing
 */

const https = require('node:https');
const http = require('node:http');

// Harper connection details - use standard env vars from integration tests
const HARPER_URL = process.env.HARPER_URL || 'http://localhost:9925';
const HARPER_USER = process.env.HDB_ADMIN_USERNAME || 'admin';
const HARPER_PASS = process.env.HDB_ADMIN_PASSWORD || 'password';

/**
 * Query Harper's operations API
 * @param {Object} operation - The Harper operation to execute
 * @returns {Promise} - Promise resolving to the query result
 */
async function harperQuery(operation) {
	const url = new URL(HARPER_URL);
	const data = JSON.stringify(operation);

	const options = {
		hostname: url.hostname,
		port: url.port || (url.protocol === 'https:' ? 443 : 80),
		path: url.pathname,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': data.length,
			'Authorization': 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64'),
		},
	};

	return new Promise((resolve, reject) => {
		const client = url.protocol === 'https:' ? https : http;
		const req = client.request(options, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => {
				try {
					const result = JSON.parse(body);
					if (result.error) {
						reject(new Error(result.error));
					} else {
						resolve(result);
					}
				} catch (e) {
					reject(e);
				}
			});
		});

		req.on('error', reject);
		req.write(data);
		req.end();
	});
}

/**
 * Get Harper's Certificate Authority from the system database
 * @returns {Promise<Object>} - Promise resolving to Harper's CA record
 */
async function getHarperCA() {
	console.log("Fetching Harper's CA from database...");

	const result = await harperQuery({
		operation: 'search_by_conditions',
		database: 'system',
		table: 'hdb_certificate',
		get_attributes: ['*'],
		conditions: [
			{
				search_attribute: 'is_authority',
				search_type: 'equals',
				search_value: true,
			},
		],
	});

	if (!result || result.length === 0) {
		throw new Error('No CA found in Harper database. Make sure Harper is running and initialized.');
	}

	// Get the first CA (should be Harper's self-generated CA)
	const ca = result[0];
	console.log(`Found CA: ${ca.name}`);
	console.log(`Private key file: ${ca.private_key_name}`);

	return ca;
}

module.exports = {
	harperQuery,
	getHarperCA,
	HARPER_URL,
	HARPER_USER,
	HARPER_PASS,
};
