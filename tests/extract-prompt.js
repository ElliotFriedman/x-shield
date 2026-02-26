#!/usr/bin/env node
// extract-prompt.js
//
// Outputs the classification system prompt to stdout so that run-tests.sh
// can capture it without starting the HTTP server.

'use strict';

const prompt = require('../system-prompt.js');
process.stdout.write(prompt);
