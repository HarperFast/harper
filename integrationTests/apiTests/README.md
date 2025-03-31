# API Integration Tests
### Test Framework composed of: 
* **SuperTest**
* **Node's Test Runner**
* **Node assert**

***

**How to run the tests**

```
node tests/1_environmentSetup.js
```
```
node --test tests/1_environmentSetup.js
```

**Run all tests under the 'tests' folder**

Some of the tests are using AWS S3 to import data. For this, if we test locally, we need to specify the S3 secret key:

```S3_KEY='value' S3_SECRET='value' node --test tests/testSuite.cjs```

When running via Github Actions we grab the values from Github Secrets in the repo.

defined in harperdb root folder in package.json in scripts:
```
"test:supertest": "cd integrationTests/apiTests && S3_KEY='value' S3_SECRET='value' node --test tests/testSuite.cjs"
```
from apiTests folder run:
```
node tests/testSuite.cjs
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
