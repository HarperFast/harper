"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = path.sep;
let directive = new upgrade_directive('1.2.005');

module.exports = directive;


