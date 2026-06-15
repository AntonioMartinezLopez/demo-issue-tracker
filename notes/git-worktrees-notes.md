# Git Worktrees — What They Are and How They Fit the Superpowers Flow

## What is a git worktree?

Normally git lets you check out one branch at a time in your working directory. If you want to work on a second branch, you have to stash your changes, switch, work, switch back.

A **worktree** is an additional working directory linked to the same repository. Each worktree has its own checked-out branch and its own files on disk — but they all share the same git object store (commits, history, etc.).

```
your-repo/                  ← main worktree (e.g. main branch)
your-repo-ticket-42/        ← worktree 1   (e.g. feature/dark-mode)
your-repo-ticket-57/        ← worktree 2   (e.g. fix/auth-bug)
your-repo-ticket-61/        ← worktree 3   (e.g. feature/export-csv)
```

All four directories are the same repo. You can have all four open simultaneously with no conflicts.

## Core git commands

```bash
# create a new worktree on a new branch
git worktree add ../your-repo-ticket-42 -b feature/dark-mode

# list all active worktrees
git worktree list

# remove a worktree after merging
git worktree remove ../your-repo-ticket-42
```

## Why worktrees matter for parallel tickets

Without worktrees, running two Claude Code sessions on the same repo would mean both sessions are on the same branch — they would overwrite each other's changes.

With worktrees, each session works in its own isolated directory on its own branch. They share history but never touch each other's files.

---

## How worktrees fit into the superpowers flow

Worktrees are created at the very start — right after brainstorming and before any code is written. The `using-git-worktrees` skill handles this automatically.

```
you: "implement ticket #42: dark mode toggle"
  │
  ▼
skill: brainstorming
  - clarifying questions
  - design approval
  │
  ▼
skill: using-git-worktrees          ◄── worktree created here
  - checks if already in a worktree
  - creates new worktree + branch:
      git worktree add ../repo-ticket-42 -b feature/dark-mode
  - installs dependencies in new worktree (npm install etc.)
  - runs full test suite to verify clean baseline
  │
  ▼
skill: writing-plans
  - plan written inside the new worktree
  │
  ▼
skill: subagent-driven-development
  - all subagents work inside the worktree
  - implementer, spec-reviewer, quality-reviewer
  │
  ▼
skill: finishing-a-development-branch
  - tests verified
  - merge options presented
  - worktree removed:
      git worktree remove ../repo-ticket-42
```

---

## Full parallel tickets flow with worktrees

Each ticket gets its own terminal session and its own worktree. Sessions run simultaneously — no coordination needed.

```
repo/                         (main branch, untouched)
repo-ticket-42/               (worktree, feature/dark-mode)
repo-ticket-57/               (worktree, fix/auth-bug)
repo-ticket-61/               (worktree, feature/export-csv)

  tab 1 (session for #42)          tab 2 (session for #57)
  ─────────────────────────         ─────────────────────────
  brainstorm #42                    brainstorm #57
  create worktree repo-ticket-42    create worktree repo-ticket-57
  write plan                        write plan
  subagent loop ──────────────────► subagent loop (concurrent)
    implementer                       implementer
    spec-reviewer                     spec-reviewer
    quality-reviewer                  quality-reviewer
  all tasks done                    all tasks done
  merge feature/dark-mode           merge fix/auth-bug
  remove worktree                   remove worktree
```

You switch between tabs while each session runs its subagent loop. You only need to intervene if a subagent reports BLOCKED or NEEDS_CONTEXT.

---

## The one risk: overlapping files

Worktrees isolate work on disk, but not in git history. If ticket #42 and ticket #57 both modify the same file, you will get a **merge conflict** when merging the second branch.

Superpowers does not solve this — it is a git problem. To avoid it:
- Pick tickets that touch different parts of the codebase
- Or merge and pull in completed branches before starting overlapping work

---

## Key points summary

| | Without worktrees | With worktrees |
|---|---|---|
| Two sessions, same repo | Overwrite each other | Fully isolated |
| Switching between tickets | Stash + checkout | Just switch tab |
| Shared history/commits | ✅ | ✅ |
| Shared object store | ✅ | ✅ |
| Cleanup | n/a | `git worktree remove` |
