import { describe, it } from 'mocha';
import {
	assertApplicationConfig,
	InvalidPackageIdentifierError,
	InvalidInstallPropertyError,
	InvalidInstallCommandError,
	InvalidInstallTimeoutError,
} from '@/components/Application';
import assert from 'node:assert/strict';

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
});
