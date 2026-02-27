#!/usr/bin/env bash
# Pre-commit hook: run tests before allowing git commits.
# Only triggers on `git commit` commands issued via Claude Code.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  exit 0
fi

PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd')
cd "$PROJECT_DIR"

echo "Running X-Shield tests before commit..." >&2

if ! bash ./tests/run-tests.sh >&2; then
  echo "Tests failed. Commit blocked." >&2
  exit 2
fi

echo "Tests passed." >&2
exit 0
