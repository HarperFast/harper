'use strict';

// This file is used in the processDirectives test to ensure only UpgradeDirective files are processed during an upgrade.
// If this exception turns up during test runs, something is broken.
throw new Error('This file should not be processed');