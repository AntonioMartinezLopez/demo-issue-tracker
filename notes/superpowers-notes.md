# Superpowers — Agent Team Notes

Repo: https://github.com/obra/superpowers
Available via the official Anthropic Claude Code plugin marketplace.

## What it is

A structured software development methodology for coding agents. Combines composable **skills** (process steps) with **subagents** (isolated executors) to keep context clean and work systematic.

## Core idea

- **Skills** = the methodology. They tell the main agent *what to do* and *when*.
- **Subagents** = fresh context windows spawned to do the actual coding work. They receive only what they need; results come back as a single message.
- The main agent never writes code directly — it orchestrates.

## Why subagents matter

Skills run inline in the main context and bloat it over time. Subagents each start cold, so heavy implementation work doesn't accumulate in the orchestrator's window.

---

## Workflow diagram

```
MAIN AGENT (orchestrator, keeps context)
│
├── skill: brainstorming
│     - asks clarifying questions
│     - presents design alternatives
│     - waits for human approval
│
├── skill: using-git-worktrees
│     - creates isolated branch
│     - verifies clean test baseline
│
├── skill: writing-plans
│     - breaks work into 2-5 min tasks
│     - exact file paths + code snippets per task
│     - verification steps per task
│
└── skill: subagent-driven-development   ◄── context isolation starts here
      - reads plan, extracts all tasks
      - loops over each task:
      │
      │   ┌─ subagent: implementer (fresh context) ─────────────┐
      │   │  - asks clarifying questions before coding           │
      │   │  - follows TDD: RED → GREEN → REFACTOR              │
      │   │  - self-reviews before reporting                     │
      │   │  - reports: DONE / BLOCKED / NEEDS_CONTEXT          │
      │   └──────────────────────────────────────────────────────┘
      │
      │   ┌─ subagent: spec-reviewer (fresh context) ───────────┐
      │   │  - checks implementation matches the spec            │
      │   │  - blocks progress if non-compliant                  │
      │   └──────────────────────────────────────────────────────┘
      │
      │   ┌─ subagent: code-quality-reviewer (fresh context) ───┐
      │   │  - checks code quality independently                 │
      │   │  - re-review required after any fixes                │
      │   └──────────────────────────────────────────────────────┘
      │
      │   task marked complete → next task
      │   (if reviewer finds issues → new fresh implementer spawned,
      │    full review cycle repeats until all reviewers pass)
      │
      ├── skill: verification-before-completion
      │     - full test suite must pass
      │
      └── skill: finishing-a-development-branch
            - presents merge options
            - cleans up worktree
```

### Optional: parallel independent tasks

```
skill: dispatching-parallel-agents
  used when 2+ tasks have no shared state or sequential dependency

  main agent ──► implementer A (fresh context)
             ──► implementer B (fresh context)  [concurrent]
             ──► implementer C (fresh context)

  main agent collects results, checks for conflicts, runs full suite
```

---

## Full skills list

| Skill | Purpose |
|---|---|
| `brainstorming` | Clarify requirements, explore design alternatives |
| `using-git-worktrees` | Isolate work on a new branch |
| `writing-plans` | Break feature into small, verifiable tasks |
| `subagent-driven-development` | Orchestrate per-task subagent cycle |
| `executing-plans` | Execute a plan step by step |
| `test-driven-development` | RED → GREEN → REFACTOR cycle |
| `requesting-code-review` | Trigger a code review |
| `receiving-code-review` | Handle review feedback |
| `verification-before-completion` | Final test suite check |
| `finishing-a-development-branch` | Merge options + worktree cleanup |
| `dispatching-parallel-agents` | Run independent tasks concurrently |
| `systematic-debugging` | Structured debugging approach |
| `using-superpowers` | Meta: how to use the framework |
| `writing-skills` | Meta: author new skills |

## Subagents defined in `subagent-driven-development`

| Subagent | Role |
|---|---|
| `implementer` | Writes the code for one task, self-reviews, reports status |
| `spec-reviewer` | Checks that implementation matches the spec (stage 1 review) |
| `code-quality-reviewer` | Checks code quality independently (stage 2 review) |

## Model selection guidance (from the skill)

- Cheap/fast model → straightforward mechanical tasks
- Standard model → integration tasks
- Most capable model → architectural decisions and reviews

## When to use parallel agents

Use `dispatching-parallel-agents` when:
- 2+ tasks are fully independent (no shared state)
- Each problem can be understood without context from others

Do not use when:
- Fixing one issue might fix others (related failures)
- Agents would edit the same files
- You are still in exploratory/debugging mode

---

## Sequential vs parallel execution

### Default: sequential (one task at a time)

Implementation tasks run one after another. Each task must fully complete its review cycle before the next starts.

```
main agent
  │
  ├─ task 1
  │    ├─► implementer       (waits)
  │    ├─► spec-reviewer     (waits)
  │    └─► quality-reviewer  (waits) ✓ done
  │
  ├─ task 2
  │    ├─► implementer       (waits)
  │    ├─► spec-reviewer     (waits)
  │    └─► quality-reviewer  (waits) ✓ done
  │
  └─ task 3 ...
```

Safe by default — no risk of two subagents editing the same file simultaneously.

### Opt-in: parallel (via dispatching-parallel-agents skill)

Only used when the main agent explicitly determines tasks are independent. Only the **implementers** run concurrently — reviews always remain sequential within each task.

```
main agent
  │
  ├─► implementer A  ──┐
  ├─► implementer B  ──┤  (concurrent)
  └─► implementer C  ──┘
                       │
                       ▼  results collected
  │
  ├─ task A reviews (sequential — confirmed by repo)
  │    ├─► spec-reviewer     (waits)
  │    └─► quality-reviewer  (waits, only if spec passes) ✓
  │
  ├─ task B reviews  ← whether A/B/C review cycles themselves
  │    ├─► spec-reviewer         run in parallel is NOT
  │    └─► quality-reviewer ✓    explicitly stated in the repo
  │
  └─ task C reviews ...
```

**What is confirmed:**
- `quality-reviewer` is only dispatched after `spec-reviewer` passes (stated explicitly in the skill)
- Implementers can run in parallel across independent tasks

**What is not specified:**
- Whether review cycles across different parallel tasks run concurrently

**Key condition for parallel dispatch:** tasks must touch different files and have no sequential dependency. If one task's output is another task's input, they must run sequentially.

---

## Review failure loop

When a reviewer returns issues, the main agent spawns a **new fresh implementer** — not the same one — with the reviewer's findings passed as context. The full review cycle then repeats until both reviewers pass.

```
implementer (attempt 1)
    │
    ▼
spec-reviewer
    │
    ├─ ✅ pass ──► quality-reviewer
    │                   │
    │                   ├─ ✅ pass → task done
    │                   │
    │                   └─ ❌ issues ──► new implementer (attempt 2)
    │                                        │
    │                                        └─► full review cycle repeats
    │
    └─ ❌ fail ──► new implementer (attempt 2)
                       │
                       └─► full review cycle repeats
```

Each retry is a fresh subagent with no memory of the previous attempt — the main agent explicitly passes the reviewer's findings in the new implementer's prompt.
