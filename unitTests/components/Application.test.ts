/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, it, beforeEach, afterEach } from 'mocha';
import {
	assertApplicationConfig,
	InvalidPackageIdentifierError,
	InvalidInstallPropertyError,
	InvalidInstallCommandError,
	InvalidInstallTimeoutError,
	Application,
	derivePackageIdentifier,
} from '@/components/Application';
import assert from 'node:assert/strict';
import { fake, restore, replace, stub } from 'sinon';
import { join } from 'node:path';

describe('Application', () => {
	describe('assertApplicationConfig', () => {
		const applicationName = 'test-application';

		it('should pass for valid minimal config', () => {
			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, { package: 'my-package' });
			});
		});

		it('should pass for valid config with install options', () => {
			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					install: {
						command: 'npm ci',
						timeout: 60000,
					},
				});
			});
		});

		it('should pass for valid config with partial install options', () => {
			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					install: { command: 'npm ci' },
				});
			});

			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					install: { timeout: 60000 },
				});
			});

			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					install: {},
				});
			});
		});

		it('should pass for config with additional, arbitrary options', () => {
			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					foo: 'bar',
					baz: 42,
					fuzz: { buzz: true },
				});
			});
		});

		it('should fail for invalid package identifiers', () => {
			const invalidValues = [null, undefined, 42, {}, [], true, false];

			for (const invalidValue of invalidValues) {
				assert.throws(
					() => {
						assertApplicationConfig(applicationName, {
							package: invalidValue,
						});
					},
					(error: Error) => {
						return (
							error instanceof InvalidPackageIdentifierError &&
							error.message ===
								`Invalid 'package' property for application ${applicationName}: expected string, got ${typeof invalidValue}`
						);
					}
				);
			}
		});

		it('should fail for invalid install property', () => {
			const invalidValues = [null, 42, 'string', [], true, false];

			for (const invalidValue of invalidValues) {
				assert.throws(
					() => {
						assertApplicationConfig(applicationName, {
							package: 'my-package',
							install: invalidValue,
						});
					},
					(error: Error) => {
						return (
							error instanceof InvalidInstallPropertyError &&
							error.message ===
								`Invalid 'install' property for application ${applicationName}: expected object, got ${typeof invalidValue}`
						);
					}
				);
			}
		});

		it('should fail for invalid install.command', () => {
			const invalidValues = [null, undefined, 42, {}, [], true, false];

			for (const invalidValue of invalidValues) {
				assert.throws(
					() => {
						assertApplicationConfig(applicationName, {
							package: 'my-package',
							install: { command: invalidValue },
						});
					},
					(error: Error) => {
						return (
							error instanceof InvalidInstallCommandError &&
							error.message ===
								`Invalid 'install.command' property for application ${applicationName}: expected string, got ${typeof invalidValue}`
						);
					}
				);
			}
		});

		it('should fail for invalid install.timeout', () => {
			const invalidValues = [null, undefined, 'string', {}, [], true, false, -1, -100];

			for (const invalidValue of invalidValues) {
				assert.throws(
					() => {
						assertApplicationConfig(applicationName, {
							package: 'my-package',
							install: { timeout: invalidValue },
						});
					},
					(error: Error) => {
						return (
							error instanceof InvalidInstallTimeoutError &&
							error.message ===
								`Invalid 'install.timeout' property for application ${applicationName}: expected non-negative number, got ${typeof invalidValue}`
						);
					}
				);
			}
		});

		it('should pass for valid timeout of 0', () => {
			assert.doesNotThrow(() => {
				assertApplicationConfig(applicationName, {
					package: 'my-package',
					install: { timeout: 0 },
				});
			});
		});
	});

	describe('derivePackageIdentifier', () => {
		// Scoped npm packages (with or without @)
		it('should prefix scoped npm package with npm:', () => {
			assert.equal(derivePackageIdentifier('@scope/package'), 'npm:@scope/package');
			assert.equal(derivePackageIdentifier('@harper/nextjs'), 'npm:@harper/nextjs');
		});

		it('should prefix unscoped npm package with npm:', () => {
			assert.equal(derivePackageIdentifier('harper'), 'npm:harper');
			assert.equal(derivePackageIdentifier('fastify'), 'npm:fastify');
		});

		// Packages that already have a prefix
		it('should not modify package identifiers that already contain a colon', () => {
			assert.equal(derivePackageIdentifier('npm:harper'), 'npm:harper');
			assert.equal(derivePackageIdentifier('file:./local-package'), 'file:./local-package');
			assert.equal(derivePackageIdentifier('github:user/repo'), 'github:user/repo');
			assert.equal(derivePackageIdentifier('git+https://harper.fast/repo.git'), 'git+https://harper.fast/repo.git');
		});

		// File paths
		it('should prefix path with file extension with file:', () => {
			// TODO: This currently resolves to `npm:` but I don't think npm actually supports `.` in package names so we should review the `derivePackageIdentifier` logic.
			// assert.equal(derivePackageIdentifier('package.tgz'), 'file:package.tgz');
			assert.equal(derivePackageIdentifier('./package.tgz'), 'file:./package.tgz');
			assert.equal(derivePackageIdentifier('./local/package.tar.gz'), 'file:./local/package.tar.gz');
			assert.equal(derivePackageIdentifier('../sibling/app.tgz'), 'file:../sibling/app.tgz');
		});

		// GitHub repos
		it('should prefix github shorthand (user/repo) with github:', () => {
			assert.equal(derivePackageIdentifier('harper/application-template'), 'github:harper/application-template');
			assert.equal(derivePackageIdentifier('user/repo'), 'github:user/repo');
		});
	});

	describe('Application class', () => {
		// Using dynamic import to get ESM module
		let logger;
		const configUtils = require('@/config/configUtils');

		const testComponentsRoot = '/test/components/root';
		let loggerWithTagStub;

		before(async () => {
			// Import the logger module to stub it
			logger = (await import('@/utility/logging/harper_logger.js')).default;
		});

		beforeEach(() => {
			replace(configUtils, 'getConfigValue', fake.returns(testComponentsRoot));
			loggerWithTagStub = stub(logger, 'loggerWithTag').returns({
				debug: fake(),
				info: fake(),
				warn: fake(),
				error: fake(),
			});
		});

		afterEach(() => {
			restore();
		});

		describe('constructor', () => {
			it('should initialize with minimal options (name and packageIdentifier)', () => {
				const app = new Application({
					name: 'my-app',
					packageIdentifier: 'lodash',
				});

				assert.equal(app.name, 'my-app');
				assert.equal(app.packageIdentifier, 'npm:lodash');
				assert.equal(app.payload, undefined);
				assert.equal(app.install, undefined);
				assert.equal(app.dirPath, join(testComponentsRoot, 'my-app'));
				assert.ok(loggerWithTagStub.calledWith('my-app'));
			});

			it('should initialize with payload instead of packageIdentifier', () => {
				const payloadBuffer = Buffer.from('test payload');
				const app = new Application({
					name: 'my-app',
					payload: payloadBuffer,
				});

				assert.equal(app.name, 'my-app');
				assert.equal(app.payload, payloadBuffer);
				assert.equal(app.packageIdentifier, undefined);
				assert.equal(app.install, undefined);
				assert.equal(app.dirPath, join(testComponentsRoot, 'my-app'));
			});

			it('should initialize with install options', () => {
				const installOptions = {
					command: 'pnpm install',
					timeout: 120000,
				};

				const app = new Application({
					name: 'my-app',
					packageIdentifier: '@scope/package',
					install: installOptions,
				});

				assert.equal(app.name, 'my-app');
				assert.equal(app.packageIdentifier, 'npm:@scope/package');
				assert.deepEqual(app.install, installOptions);
			});

			it('should derive packageIdentifier when provided', () => {
				const testCases = [
					{ input: 'lodash', expected: 'npm:lodash' },
					{ input: '@scope/package', expected: 'npm:@scope/package' },
					{ input: 'user/repo', expected: 'github:user/repo' },
					{ input: 'npm:express', expected: 'npm:express' },
				];

				for (const { input, expected } of testCases) {
					const app = new Application({
						name: 'test-app',
						packageIdentifier: input,
					});

					assert.equal(app.packageIdentifier, expected);
				}
			});

			it('should construct correct dirPath from COMPONENTSROOT and name', () => {
				const app = new Application({
					name: 'my-app',
					packageIdentifier: 'lodash',
				});

				assert.equal(app.dirPath, join(testComponentsRoot, 'my-app'));
				assert.ok(configUtils.getConfigValue.called);
			});

			it('should initialize logger with application name tag', () => {
				const appName = 'test-application';
				const app = new Application({
					name: appName,
					packageIdentifier: 'lodash',
				});

				assert.ok(loggerWithTagStub.calledOnceWith(appName));
				assert.ok(app.logger);
			});

			it('should handle payload as base64 string', () => {
				const base64Payload = Buffer.from('test data').toString('base64');
				const app = new Application({
					name: 'my-app',
					payload: base64Payload,
				});

				assert.equal(app.name, 'my-app');
				assert.equal(app.payload, base64Payload);
				assert.equal(app.packageIdentifier, undefined);
			});

			it('should allow both payload and install options', () => {
				const app = new Application({
					name: 'my-app',
					payload: Buffer.from('data'),
					install: { timeout: 60000 },
				});

				assert.ok(app.payload);
				assert.deepEqual(app.install, { timeout: 60000 });
			});
		});
	});
});
