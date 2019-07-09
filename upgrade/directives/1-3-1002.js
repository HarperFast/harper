"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');

let directive = new upgrade_directive('1.3.1002');

module.exports = directive;