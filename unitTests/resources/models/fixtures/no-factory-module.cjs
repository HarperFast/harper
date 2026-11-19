'use strict';
// #1471 test fixture: a module that exports no usable factory, exercising the
// "must export a default function (or a 'register' export)" guard.
module.exports = { notAFactory: true };
