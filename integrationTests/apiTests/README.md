# API Integration Tests
### Test Framework composed of: 
* **SuperTest**
* **Node's Test Runner**
* **Node assert**

***

**How to run the tests**

Note: Harper needs to be running before starting the tests

Run the tests from /integrationTests/apiTests folder:

```
node --experimental-default-type="module" --stack-trace-limit=2 tests/1_environmentSetup.js
```
```
node --experimental-default-type="module" --stack-trace-limit=2 --test tests/1_environmentSetup.js
```

**Run all tests under the 'tests' folder**

Some of the tests are using AWS S3 to import data. For this, if we test locally, we need to specify the S3 secret key:

```S3_KEY='value' S3_SECRET='value' node --experimental-default-type="module" --stack-trace-limit=2 --test tests/testSuite.js```

or we can remove them from the command line and add them in the .env file in the root directory /integrationTests/apiTests/.env like this:
```
S3_KEY=value
S3_SECRET=value
```

To run a test from the IDE that uses the environment variables specified in the .env file, use the Run Configuration saved as RunATestWithEnvFile.run.xml.
Replace the Test file and the Test name with your test.  

When running via Github Actions we grab the values from Github Secrets in the repo.

defined in harperdb root folder in package.json in scripts:
```
"test:supertest": "cd integrationTests/apiTests && S3_KEY='value' S3_SECRET='value' node --experimental-default-type="module" --stack-trace-limit=2 --test tests/testSuite.js"
```
from apiTests folder run:
```
node --experimental-default-type="module" --stack-trace-limit=2 tests/testSuite.js
```

Test Reports formats: spec, dot and tap

add the following to the node command:
```
--test-reporter spec --test-reporter-destination report.txt --test-reporter spec --test-reporter-destination stdout
```

***

**To speed up the test execution, see the Test runner execution model** 
* isolation
  * configures the type of test isolation. 
  * if set to 'process', each test file is run in a separate child process. 
  * if set to 'none', all test files run in the current process. Default: 'process'.
  * https://nodejs.org/api/cli.html#--experimental-test-isolationmode
* test-concurrency
  * https://nodejs.org/api/cli.html#--test-concurrency
