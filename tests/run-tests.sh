#!/usr/bin/env bash
# run-tests.sh — X-Shield classification test harness
#
# Runs each .md fixture through the Claude CLI with the same system prompt
# used by server.js, then compares the actual verdict to the expected verdict.
#
# Usage:
#   ./tests/run-tests.sh              # run all fixtures
#   ./tests/run-tests.sh filter       # run only filter/ fixtures
#   ./tests/run-tests.sh show distill # run show/ and distill/ fixtures
#
# Each fixture is a .md file in tests/fixtures/{show,distill,filter,nourish}/ with:
#   # Tweet
#   [tweet text]
#   ## Quote           (optional, for quote tweets)
#   [quoted text]
#   ## Expected
#   verdict: show|distill|filter
#   reason: ...

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Counters
PASSED=0
FAILED=0
ERRORS=0
TOTAL=0

# ---------------------------------------------------------------------------
# Step 1: Extract the system prompt from server.js
# ---------------------------------------------------------------------------
echo -e "${BOLD}X-Shield Classification Test Harness${RESET}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

echo -e "${DIM}Extracting system prompt from server.js...${RESET}"
SYSTEM_PROMPT="$(node "$SCRIPT_DIR/extract-prompt.js")"

if [ -z "$SYSTEM_PROMPT" ]; then
  echo -e "${RED}ERROR: Failed to extract system prompt${RESET}"
  exit 1
fi

PROMPT_LINES=$(echo "$SYSTEM_PROMPT" | wc -l | tr -d ' ')
echo -e "${DIM}  System prompt extracted (${PROMPT_LINES} lines)${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Determine which categories to test
# ---------------------------------------------------------------------------
if [ $# -gt 0 ]; then
  CATEGORIES=("$@")
else
  CATEGORIES=(show distill filter nourish)
fi

# ---------------------------------------------------------------------------
# Step 3: Parse a fixture file
#
# Sets these variables:
#   TWEET_TEXT     — the main tweet body
#   QUOTE_TEXT     — quoted tweet text (empty if none)
#   EXPECTED       — expected verdict (show/distill/filter)
#   EXPECTED_REASON — expected reason (for display only)
# ---------------------------------------------------------------------------
parse_fixture() {
  local file="$1"

  TWEET_TEXT=""
  QUOTE_TEXT=""
  EXPECTED=""
  EXPECTED_REASON=""

  local section=""      # current section: tweet, quote, expected
  local content=""

  while IFS= read -r line; do
    # Detect section headers
    if [[ "$line" == "# Tweet" ]]; then
      section="tweet"
      continue
    elif [[ "$line" == "## Quote" ]]; then
      # Save tweet text collected so far
      TWEET_TEXT="$content"
      content=""
      section="quote"
      continue
    elif [[ "$line" == "## Expected" ]]; then
      # Save whatever section was being collected
      if [[ "$section" == "quote" ]]; then
        QUOTE_TEXT="$content"
      else
        TWEET_TEXT="$content"
      fi
      content=""
      section="expected"
      continue
    fi

    # Collect content based on current section
    case "$section" in
      tweet|quote)
        if [ -n "$content" ]; then
          content="$content
$line"
        else
          content="$line"
        fi
        ;;
      expected)
        if [[ "$line" =~ ^verdict:\ *(.*) ]]; then
          EXPECTED="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^reason:\ *(.*) ]]; then
          EXPECTED_REASON="${BASH_REMATCH[1]}"
        fi
        ;;
    esac
  done < "$file"

  # Trim leading/trailing blank lines from tweet and quote text
  # (Using perl for macOS/BSD compatibility)
  TWEET_TEXT="$(printf '%s' "$TWEET_TEXT" | perl -0pe 's/\A\s*\n//; s/\n\s*\z//')"
  QUOTE_TEXT="$(printf '%s' "$QUOTE_TEXT" | perl -0pe 's/\A\s*\n//; s/\n\s*\z//')"
}

# ---------------------------------------------------------------------------
# Step 4: Format tweet text the way server.js does
# ---------------------------------------------------------------------------
format_tweet() {
  local text="$TWEET_TEXT"

  # Append quote tweet if present (matches content.js format)
  if [ -n "$QUOTE_TEXT" ]; then
    text="$text
Quote: $QUOTE_TEXT"
  fi

  # Wrap in the server.js batch format
  echo "--- tweet_0 (id: test) ---
$text"
}

# ---------------------------------------------------------------------------
# Step 5: Run classification via Claude CLI
#
# Returns the verdict string (show/distill/filter) or "ERROR" on failure.
# ---------------------------------------------------------------------------
classify_tweet() {
  local formatted_tweet="$1"
  local raw_output
  local exit_code=0

  # Call claude CLI with the same args server.js uses
  raw_output=$(echo "$formatted_tweet" | claude \
    -p \
    --system-prompt "$SYSTEM_PROMPT" \
    --output-format json \
    --model sonnet \
    --no-session-persistence \
    --tools "" \
    2>/dev/null) || exit_code=$?

  if [ $exit_code -ne 0 ]; then
    echo "ERROR:claude exited with code $exit_code"
    return
  fi

  # --output-format json wraps the result: {"result": "..."}
  # The inner result is a JSON string containing the verdict array.
  # We need to: parse outer JSON -> get .result -> parse inner JSON -> get verdict

  local verdict
  verdict=$(echo "$raw_output" | node -e "
    let input = '';
    process.stdin.on('data', d => input += d);
    process.stdin.on('end', () => {
      try {
        const outer = JSON.parse(input);
        let result = outer.result || input;

        // Strip markdown fences if present
        result = result.trim();
        if (result.startsWith('\`\`\`')) {
          result = result.replace(/^\`\`\`(?:json)?\s*\n?/, '').replace(/\n?\s*\`\`\`\s*$/, '');
        }

        const verdicts = JSON.parse(result);
        if (Array.isArray(verdicts) && verdicts.length > 0) {
          // Output verdict and reason separated by tab
          console.log(verdicts[0].verdict + '\t' + (verdicts[0].reason || ''));
        } else {
          console.log('ERROR\tUnexpected JSON structure: ' + result);
        }
      } catch (e) {
        console.log('ERROR\tFailed to parse: ' + e.message);
      }
    });
  " 2>/dev/null)

  echo "$verdict"
}

# ---------------------------------------------------------------------------
# Step 6: Run tests
# ---------------------------------------------------------------------------
echo -e "${BOLD}Running tests...${RESET}"
echo ""

for category in "${CATEGORIES[@]}"; do
  category_dir="$FIXTURES_DIR/$category"

  if [ ! -d "$category_dir" ]; then
    echo -e "${YELLOW}WARNING: No fixture directory for '$category', skipping${RESET}"
    continue
  fi

  # Count fixtures in this category
  fixture_count=$(find "$category_dir" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$fixture_count" -eq 0 ]; then
    echo -e "${YELLOW}WARNING: No .md fixtures in $category/, skipping${RESET}"
    continue
  fi

  echo -e "${BOLD}${CYAN}[$category]${RESET} ($fixture_count fixtures)"

  for fixture in "$category_dir"/*.md; do
    TOTAL=$((TOTAL + 1))
    fixture_name="$(basename "$fixture" .md)"

    # Parse the fixture file
    parse_fixture "$fixture"

    if [ -z "$EXPECTED" ]; then
      echo -e "  ${YELLOW}SKIP${RESET}  $fixture_name — no expected verdict found"
      ERRORS=$((ERRORS + 1))
      continue
    fi

    # Format the tweet
    formatted="$(format_tweet)"

    # Classify
    echo -ne "  ${DIM}...${RESET}   $fixture_name"

    result="$(classify_tweet "$formatted")"

    # Split result into verdict and reason (tab-separated)
    actual_verdict="$(echo "$result" | cut -f1)"
    actual_reason="$(echo "$result" | cut -f2-)"

    # Clear the "running" line and print result
    echo -ne "\r"

    if [[ "$actual_verdict" == ERROR* ]]; then
      echo -e "  ${YELLOW}ERR ${RESET}  $fixture_name"
      echo -e "         ${DIM}Error: ${actual_reason}${RESET}"
      ERRORS=$((ERRORS + 1))
    elif [ "$actual_verdict" = "$EXPECTED" ]; then
      echo -e "  ${GREEN}PASS${RESET}  $fixture_name"
      echo -e "         ${DIM}Expected: $EXPECTED | Got: $actual_verdict ($actual_reason)${RESET}"
      PASSED=$((PASSED + 1))
    else
      echo -e "  ${RED}FAIL${RESET}  $fixture_name"
      echo -e "         ${RED}Expected: $EXPECTED | Got: $actual_verdict ($actual_reason)${RESET}"
      FAILED=$((FAILED + 1))
    fi
  done

  echo ""
done

# ---------------------------------------------------------------------------
# Step 7: Summary
# ---------------------------------------------------------------------------
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}Results:${RESET} $TOTAL total, ${GREEN}$PASSED passed${RESET}, ${RED}$FAILED failed${RESET}, ${YELLOW}$ERRORS errors${RESET}"

if [ $FAILED -eq 0 ] && [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All tests passed.${RESET}"
  exit 0
else
  exit 1
fi
