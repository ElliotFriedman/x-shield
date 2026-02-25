#!/usr/bin/env node
// extract-prompt.js
//
// Reads server.js as raw text and extracts the CLASSIFICATION_SYSTEM_PROMPT
// template literal. Outputs the prompt string to stdout so that run-tests.sh
// can capture it without starting the HTTP server.

'use strict';

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

// The prompt is assigned as:
//   const CLASSIFICATION_SYSTEM_PROMPT = `...`;
//
// We find the opening backtick after the variable name and then scan forward
// for the matching closing backtick (handling escaped backticks \`).

const marker = 'const CLASSIFICATION_SYSTEM_PROMPT = `';
const start = source.indexOf(marker);
if (start === -1) {
  console.error('ERROR: Could not find CLASSIFICATION_SYSTEM_PROMPT in server.js');
  process.exit(1);
}

const promptStart = start + marker.length;

// Scan for the unescaped closing backtick
let i = promptStart;
while (i < source.length) {
  if (source[i] === '\\') {
    // Skip escaped character
    i += 2;
    continue;
  }
  if (source[i] === '`') {
    break;
  }
  i++;
}

if (i >= source.length) {
  console.error('ERROR: Could not find closing backtick for CLASSIFICATION_SYSTEM_PROMPT');
  process.exit(1);
}

const prompt = source.slice(promptStart, i);

// Output the raw prompt (template literals with no interpolation are just strings)
process.stdout.write(prompt);
