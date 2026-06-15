#!/usr/bin/env bash
set -euo pipefail

# Reads a Bash tool-call payload on stdin. If the command is a `git commit`,
# runs `npm run typecheck` and — on failure — emits a permissionDecision of
# "deny" with the compiler errors as the reason. Any other command passes
# through silently.
#
# Provided for you. Your job is to figure out where in the plugin this needs
# to be wired up so it actually fires.

payload=$(cat)
command=$(echo "$payload" | jq -r '.tool_input.command // empty')

case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

if ! errors=$(npm run --silent typecheck 2>&1); then
  jq -n --arg errors "$errors" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Blocked: `npm run typecheck` must pass before committing.\n\n" + $errors)
    }
  }'
fi

exit 0
