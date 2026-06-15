# Solution — "Definition of Done"

The brief contains two requirements with very different shapes. The whole
exercise is a classification problem: *which plugin building block fits each
one?*

```
plugin/
├── .claude-plugin/plugin.json   ← manifest: declares the hooks + skills dirs
├── hooks/hooks.json             ← wires the gate script as a PreToolUse hook
├── scripts/typecheck-gate.sh    ← (provided) runs typecheck, denies on red
└── skills/wrap-up/SKILL.md      ← natural-language wrap-up ritual
```

Every file below is shown in full with a note on each line explaining what it
does and why it's the right call.

---

## Requirement 1 → PreToolUse hook

> *"I don't want to rely on the agent choosing to be helpful about it. It
> needs to be enforced — the commit doesn't happen."*

"Enforced" and "doesn't happen" rule out everything prompt-shaped. A skill, a
slash command, or a CLAUDE.md note can only *ask* the model to behave. A hook
runs in the harness, outside the model's control — the only mechanism that
matches "enforced." And it must be **PreToolUse**, because the commit has to
be vetoed *before* it runs; PostToolUse fires after the damage is done.

### `hooks/hooks.json` — annotated

```jsonc
{
  "hooks": {
    "PreToolUse": [                        // ← fires BEFORE a tool runs — the only event that can veto a call
      {
        "matcher": "Bash",                 // ← tool-name regex; `git commit` is a Bash call, so match Bash
                                           //   (matchers can't see the command string, so we filter inside the script)
        "hooks": [
          {
            "type": "command",             // ← run a shell command as the hook body
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/typecheck-gate.sh\""
                                           // ← ${CLAUDE_PLUGIN_ROOT} resolves to wherever the plugin is installed,
                                           //   so the path works on every machine — never hard-code an absolute path
          }
        ]
      }
    ]
  }
}
```

### `scripts/typecheck-gate.sh` — annotated (provided to the learner)

```bash
#!/usr/bin/env bash
set -euo pipefail                          # ← fail fast on errors / unset vars — don't let a typo silently allow a commit

payload=$(cat)                             # ← PreToolUse delivers the tool-call JSON on stdin; capture it once
command=$(echo "$payload" \
  | jq -r '.tool_input.command // empty')  # ← pull out the actual shell command the agent is about to run

case "$command" in
  *"git commit"*) ;;                       # ← only guard commits — fall through to the check below
  *) exit 0 ;;                             # ← anything else: exit 0 with no output = "allow, I have no opinion"
esac                                       #   (this early-exit keeps the hook ~free on the 99% of Bash calls that aren't commits)

if ! errors=$(npm run --silent typecheck 2>&1); then
                                           # ← run the team's existing typecheck script; capture stderr+stdout so we can show the errors
  jq -n --arg errors "$errors" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",          # ← structured deny: the harness blocks the tool AND feeds the reason back to the agent
      permissionDecisionReason: ("Blocked: `npm run typecheck` must pass before committing.\n\n" + $errors)
                                           # ← include the real compiler output so the agent can show the dev exactly what's broken
    }
  }'
fi

exit 0                                     # ← typecheck passed (or wasn't a commit): allow silently
```

**Why `permissionDecision: "deny"` instead of `exit 2`:** both block the call,
but the JSON form carries the compiler output back as the reason, so the agent
can explain the failure instead of just saying "hook said no."

---

## Requirement 2 → Skill

> *"…honestly, whatever words come out of their mouth — and the agent just
> does all three. They shouldn't have to look up a specific command name."*

A slash command needs the user to type an exact `/name` — the PM explicitly
doesn't want that. A hook can't fire on "the user said something that sounds
like they're done." A **skill** is the only building block whose `description`
is read by the model to match free-form intent.

### `skills/wrap-up/SKILL.md` — annotated

```markdown
---
name: Wrap up an issue                     # ← human-readable label; shows up in /skills listings
description: |                             # ← THIS is the trigger — the agent reads it to decide when to invoke the skill,
  Use when the user signals they've        #   so front-load the actual phrases devs will say. Vague description = skill never fires.
  finished work on an issue and want to
  close it out — phrases like "wrap up
  <issue>", "I'm done with #3", "finish
  the board-layout ticket", "close that
  one out". Performs the team's full
  wrap-up ritual so the user doesn't have
  to remember the steps.
---

The board's REST API is at `http://localhost:3000/api/issues`.
                                           # ← state the base URL once so the steps below don't repeat it

When the user is wrapping up an issue:

1. **Resolve the issue.** `curl -s http://localhost:3000/api/issues` and find
   the one they mean — by id if they gave a number, otherwise by closest
   title match. State which issue you matched in one line.
                                           # ← lets "wrap up the board thing" work, not just "wrap up #3";
                                           #   echoing the match gives the dev a chance to abort if it picked wrong

2. **Summarise the change.** Look at the working tree / recent diff and write
   a single plain-English sentence describing what changed.
                                           # ← "single sentence" keeps the model from dumping a paragraph into the card

3. **Apply all three updates in one PATCH:**
                                           # ← one request = atomic on the board; never shows "Done but still assigned"
   ```bash
   curl -s -X PATCH http://localhost:3000/api/issues/<id> \
     -H 'content-type: application/json' \
     -d '{"status":"done","assignee":null,"description":"<existing>\n\nResolved: <summary>"}'
   ```
                                           # ← give the literal curl shape — concrete recipes stop the model improvising the API wrong

4. Report which card moved and what summary was recorded. Do not pause for
   confirmation between steps — the whole point is that this is one motion.
                                           # ← without this the agent tends to ask "should I proceed?" between each step,
                                           #   which is exactly the friction the PM wants gone
```

---

## `.claude-plugin/plugin.json` — annotated

```jsonc
{
  "name": "issue-ops",
  "version": "0.1.0",
  "description": "Team workflow for the Issue Tracker: blocks commits on red typecheck and teaches the agent the issue wrap-up ritual.",
                                           // ← shown at install time — say what the plugin DOES, not what it contains
  "author": "Issue Tracker Team",
  "hooks": "./hooks/hooks.json",           // ← ADDED: without this the hook file is just dead text on disk
  "skills": "./skills"                     // ← ADDED: points at the directory; every subfolder with a SKILL.md is loaded
}
```

---

## How the two compose

The skill is the happy path; the hook is the safety net. They're orthogonal —
the hook guards *every* commit, whether it came from the skill, from some
other prompt, or from the dev typing "just commit it." The skill never has to
mention typecheck at all, because the gate is enforced one layer down.

### Demo

1. Break a type in `lib/types.ts`.
2. Ask the agent to commit → **hook blocks it**, compiler errors shown.
3. Fix the type.
4. Say "I'm done with the board layout issue" → **skill fires**, card moves to
   Done in the browser, assignee clears, summary lands in the description.
