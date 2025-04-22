import { describe } from 'node:test';

describe('Main Test Suite', async () => {
	await import('./0_envCleanup.js');
	await import('./1_environmentSetup.js');
	await import('./2_dataLoad.js');
	await import('./3_sqlTests.js');
	await import('./4_noSqlTests.js');
	await import('./5_noSqlRoleTesting.js');
	await import('./6_sqlRoleTesting.js');
	await import('./7_jobsAndJobRoleTesting.js');
	await import('./8_deleteTests.js');
	await import('./8a_restartHdbToUpdateConfig.js');
	await import('./9_transactions.js');
	await import('./10_otherRoleTests.js');
	await import('./11_alterUserTests.js');
	await import('./12_configuration.js');
	await import('./13_systemInformation.js');
	await import('./14_tokenAuth.js');
	await import('./15_customFunctionsAndComponents.js');
	await import('./16_terminologyUpdates.js');
	await import('./17_environmentCleanUp.js');
	await import('./17a_addComponents.js');
	await import('./18_computedIndexedProperties.js');
	await import('./19_graphQlTests.js');
	await import('./20_restTests.js');
	await import('./21_authenticationTests.js');
	await import('./22_openApi.js');
});
