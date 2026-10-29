const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const loaderPath = require.resolve('#src/utility/AWS/awsSdkLoader');
const pidRootHelper = require.resolve('../../perPidRoot.js');

function runProbe(body) {
	let output = '';
	try {
		output = execFileSync(
			process.execPath,
			[...(loaderPath.endsWith('.ts') ? ['--conditions=typestrip'] : []), '--input-type=module'],
			{
				input: `
				const { createRequire } = await import('node:module');
				const require = createRequire(${JSON.stringify(pathToFileURL(pidRootHelper).href)});
				process.env.ROOTPATH = require(${JSON.stringify(pidRootHelper)}).materializePerPidRoot();
				console.log('sdk-root ' + process.pid);
				const assert = (await import('node:assert')).default;
				${body}
				console.log('SDK probe complete');
				process.exit(0);`,
				env: process.env,
				encoding: 'utf8',
				timeout: 20000,
			}
		);
		assert.match(output, /^SDK probe complete$/m);
	} catch (error) {
		output = error.stdout?.toString() ?? output;
		throw error;
	} finally {
		const pid = /^sdk-root (\d+)\r?$/m.exec(output)?.[1];
		if (pid) rmSync(join(dirname(pidRootHelper), 'envDir', pid), { recursive: true, force: true });
	}
}

describe('native optional S3 SDK loading', () => {
	it('loads the installed SDK through the default resolver', () => {
		runProbe(`
			const { requireAwsSdk } = await import(${JSON.stringify(pathToFileURL(loaderPath).href)});
			assert.strictEqual(typeof requireAwsSdk('@aws-sdk/client-s3').S3, 'function');
		`);
	});

	it('constructs an S3 client with the requested credentials and region', () => {
		const connectorUrl = pathToFileURL(require.resolve('#src/utility/AWS/AWSConnector')).href;
		runProbe(`
			const { getS3AuthObj } = await import(${JSON.stringify(connectorUrl)});
			const client = getS3AuthObj('source-key', 'source-secret', 'us-east-1');
			try {
				const credentials = await client.config.credentials();
				assert.strictEqual(credentials.accessKeyId, 'source-key');
				assert.strictEqual(credentials.secretAccessKey, 'source-secret');
				assert.strictEqual(await client.config.region(), 'us-east-1');
			} finally { client.destroy(); }
		`);
	});
});
