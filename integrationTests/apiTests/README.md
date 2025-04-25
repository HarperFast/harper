# API Integration Tests

## Test Framework composed of: 
* [**SuperTest**](https://www.npmjs.com/package/supertest)
* [**Node.js Test Runner**](http://nodejs.org/docs/latest/api/test.html)
* [**Node.js `assert`**](https://nodejs.org/docs/latest/api/assert.html)

***

## How to run the tests

> Notes:
> 
> Harper needs to be running before starting the tests.
>
> Some tests require AWS S3 to import data. The S3 key and secret must be specified as environment variables (`S3_KEY` and `S3_SECRET`) or in the `/integrationTests/apiTests/.env` file. See example file `.env.test.example`


Run all integration tests directly from the root of the repo using the npm script `test:integration`.

 
```
npm run test:integration
```

Use the Node.js test runner to run the tests from the `/integrationTests/apiTests` folder.

If using a Node.js versions less than v22, include `--experimental-default-type="module"` in order to automatically support ESM syntax. 

```sh
node --test tests/1_environmentSetup.js
```

For more information, review the [Node.js test runner](https://nodejs.org/docs/latest/api/test.html#running-tests-from-the-command-line) documentation.


### Run all tests

```
cd /integrationTests/apiTests

S3_KEY='value' S3_SECRET='value' node --experimental-default-type="module" --stack-trace-limit=2 --test tests/testSuite.js
```

or specify them in an `/integrationTests/apiTests/.env` file:
```
S3_KEY=value
S3_SECRET=value
```
With .env file set, run:
```
node --experimental-default-type="module" --stack-trace-limit=2 --test tests/testSuite.js
```

When running via GitHub Actions we grab the values from GitHub Secrets in the repo.

To run a test from the IDE that uses the environment variables specified in the .env file, use the Run Configuration saved as RunATestWithEnvFile.run.xml.
Replace the Test file and the Test name with your test.  


Docker

When running against a docker container, you need to copy the csv files to docker first
```
docker cp test/data/integrationTestsCsvs/ $containerId:/home/harperdb/
```
and then run:
```
FILES_LOCATION=/home/harperdb/integrationTestsCsvs/ S3_KEY=${S3_KEY} S3_SECRET=${S3_SECRET} node --test-reporter spec --test-reporter-destination report.txt --test-reporter spec --test-reporter-destination stdout --experimental-default-type="module" --stack-trace-limit=2 tests/testSuite.js
```

### Test Reporters

Report formats: spec, dot and tap

Node.js test runner provides many test reporter options. Use the `--test-reporter` and `--test-reporter-destination` CLI flags to configure. For more information review the Node.js Test Runner [Test Reporters](https://nodejs.org/docs/latest/api/test.html#test-reporters) documentation.
For example, to customize the output, add the following to the node command:
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
