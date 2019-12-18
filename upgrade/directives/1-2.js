"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');

let directives = [];
let directive_1_2_0 = new upgrade_directive('1.2.0');
directive_1_2_0.change_description = `Version 1.2.0`;
directives.push(directive_1_2_0);
let directive_1_2_0_1 = new upgrade_directive('1.2.0.1');
directive_1_2_0_1.change_description = `Version 1.2.0.1`;
directives.push(directive_1_2_0_1);
let directive_1_2_005 = new upgrade_directive('1.2.005');
directive_1_2_005.change_description = `Version 1.2.005`;
directives.push(directive_1_2_005);
let directive_1_2_006 = new upgrade_directive('1.2.006');
directive_1_2_006.change_description = `Version 1.2.006`;
directives.push(directive_1_2_006);

module.exports = directives;


