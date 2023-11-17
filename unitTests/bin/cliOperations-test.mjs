import { setupTestApp } from '../apiTests/setupTestApp.mjs';
import {buildRequest, cliOperations} from '../../bin/cliOperations.js'

describe('test REST calls', () => {
	let available_records;

	before(async function() {
		this.timeout(5000);
		available_records = await setupTestApp();
	})

	it('test start server', async () => {

		process.argv.push('describe_all')
		const cli_api_op = buildRequest();
		await cliOperations(cli_api_op)

	});
});
