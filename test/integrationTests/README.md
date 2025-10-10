# API Integration Tests

This directory contains [Node.js test runner](https://nodejs.org/docs/latest/api/test.html) based integration tests for the Harper platform.

> [!Note]
> These tests were initially migrated from the Postman based integration tests and will be updated to be more modular and independent over time.

These tests primarily use [supertest](https://www.npmjs.com/package/supertest) for HTTP assertions and the [Node.js `assert` module](https://nodejs.org/docs/latest/api/assert.html) for any additional assertions. The tests are designed to primarily validate the Harper API endpoints and their functionality.

## How to run the tests

> [!Note]
> The tests are not currently independent or idempotent. Until the entire suite is updated, it is recommended to run them via the `tests/testSuite.mjs` file (which runs them in the correct order). Furthermore, we recommend a clean Harper instance as sometimes existing artifacts can cause failures.

1. Run Harper: `harper start`
2. Ensure the environment variables `HDB_ADMIN_USERNAME` and `HDB_ADMIN_PASSWORD` are set
   1. They can be set in the path directly, or via a `.env` file in the `integrationTests/apiTests/` directory. For an example, see the `.env.example` file.
   2. Values set in the path take precedence over those in a `.env` file.
3. Run the tests using the Node.js test runner
   1. Included npm script: `npm run test:integration`
   2. Directly using the Node.js test runner command `node --test <path>/tests/testSuite.mjs`

> [!Note]
> On Node.js versions less than v22, you need to include the `--experimental-default-type=module` flag to support ESM syntax.

In certain environments, such as a Docker container, you may need to manually copy the CSV files used in certain tests to the container. The CSV files are located in `harper/test/data/`. Depending on your setup, you can use the `FILES_LOCATION` environment variable to specify the location of these files. For example:

```bash
FILES_LOCATION=/home/harper/test/data/ npm run test:integration
```

## Test Reporters

The Node.js test runner support various test report formats. By default, it uses the `spec` reporter, which provides a hierarchical view of the tests and their results. However, you can customize the output format and destination using the `--test-reporter` and `--test-reporter-destination` CLI flags.

For example, to generate a report in the `spec` format and save it to a file named `report.txt`, while also outputting the results to the console, you can run:

```bash
node --test \
     --test-reporter=spec \
     --test-reporter-destination=report.txt \
     --test-reporter=spec \
     --test-reporter-destination=stdout \
     tests/testSuite.mjs
```
