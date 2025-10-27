# Contributing to Harper

> [!NOTE]
> Harper open source core is still under active development.
>
> The source code in this repository was extracted directly from our old, closed-source codebase.
>
> Stay tuned to this repo and our public channels (such as our [Discord](https://discord.gg/VzZuaw3Xay) community) for updates as we continue to develop the future of open source Harper.

Contributors are encouraged to communicate with maintainers in issues or other channels (such as our community [Discord](https://discord.gg/VzZuaw3Xay)) before submitting changes.

## Getting Started

Install dependencies using `npm install`

Build the project using `npm run build` or `npm run build:watch` to automatically rebuild on file changes.

Run integration tests using `npm run test:integration`. Make sure to read the [integration test instructions](./integrationTests/apiTests/README.md) for setup.

Run unit tests using `npm run test:unit <unit-test-file>` or `npm run test:unit:all`.

> Unit tests currently use [Mocha](https://mochajs.org/) as the test runner, but since they are implemented in TypeScript and are sometimes executing TypeScript source code, it also uses [TSX](https://tsx.is/) for compilation and execution. The npm script `test:unit` sets the appropriate env vars and mocha configuration file. Make sure that the `TSX_TSCONFIG_PATH` environment variable points to the correct `tsconfig.json` file for the unit tests (i.e. `./unitTests/tsconfig.json`) and not the root-level `tsconfig.json`.

## Repository Structure

Most of the content within this repo is source files. The exceptions are `static` and `test` directories, and various configuration files (such as `eslint.config.mjs`, `prettier.config.mjs`, and `tsconfig.json`).

## Code of Conduct

Harper has a [Code of Conduct](./CODE_OF_CONDUCT.md) that all contributors are expected to follow.
