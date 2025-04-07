//TEST SUITE
//in order of execution:

require('./0_envCleanup.js');
require('./1_environmentSetup.js');
require('./2_dataLoad.js');
require('./3_sqlTests.js');
require('./4_noSqlTests.js');
require('./5_noSqlRoleTesting.js');
require('./6_sqlRoleTesting.js');
require('./7_jobsAndJobRoleTesting.js');
require('./8_deleteTests.js');
require('./8a_restartHdbToUpdateConfig.js');
require('./9_transactions.js');
require('./10_otherRoleTests.js');
require('./11_alterUserTests.js');
require('./12_configuration.js');
require('./13_systemInformation.js');
require('./14_tokenAuth.js');
require('./15_customFunctionsAndComponents.js');
require('./16_terminologyUpdates.js');
require('./17_environmentCleanUp.js');
require('./18_computedIndexedProperties.js');
require('./19_graphQlTests.js');
require('./20_restTests.js');
require('./21_authenticationTests.js');
require('./22_openApi.js');
