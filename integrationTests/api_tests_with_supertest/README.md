# API Integration Tests
### Test Framework composed of: 
* **SuperTest**
* **Node's Test Runner**
* **Node assert**

***

**How to run the tests**

```
node tests/1_environment_setup.js
```
```
node --test tests/1_environment_setup.js
```

**Run all tests under the 'tests' folder**
```
npm run tests
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
