#!/bin/sh
# Fake claude for shadow tests: logs argv to $FAKE_CLAUDE_LOG, answers auth/status, runs and the judge.
echo "$*" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
[ "$1" = "auth" ] && { [ -n "$FAKE_LOGGED_OUT" ] && exit 1; echo '{"loggedIn":true}'; exit 0; }
echo "CWD: $PWD" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
input=$(cat)
echo "STDIN: $(echo "$input" | head -c 400 | tr '\n' ' ')" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
case "$input" in
  *"Task prompt"*) echo '{"result":"{\"verdict\":\"cheap_worse\",\"reason\":\"missed a case\"}","total_cost_usd":0.02}' ;;
  *) echo "edited" > "edit-$$.txt"; echo '{"result":"done","total_cost_usd":0.1}' ;;
esac
