# Plugin Exercise: "Definition of Done"

You've just joined the team that builds this issue tracker. The PM has sent you
the note below. Your job is to extend the team's Claude Code plugin so that
both asks work out-of-the-box for any dev who installs it.

Read the brief, decide which plugin building blocks you need, then build them.

---

> **From:** Jordan (PM, Issue Tracker)
> **To:** you
> **Subject:** two things driving me nuts
>
> Now that the team is pairing with the coding agent all day, two problems
> keep coming up:
>
> **1. Broken code keeps getting committed.**
> Someone tells the agent "looks good, commit it," the agent runs
> `git commit`, and ten minutes later CI is red because `npm run typecheck`
> fails. Our rule is simple: *no commit while typecheck is failing.* I don't
> want devs to have to remember to run it first, and I don't want to rely on
> the agent choosing to be helpful about it. It needs to be enforced — if the
> agent tries to commit while typecheck is red, the commit doesn't happen and
> the dev sees the errors.
>
> **2. Nobody does the full wrap-up ritual.**
> When work on an issue is actually finished, three things are supposed to
> happen: the card moves to **Done** on the board, the **assignee is cleared**,
> and a **one-line summary** of what changed gets appended to the issue
> description. Devs do step one and forget the rest every time. I'd like a dev
> to be able to say "wrap up the board-layout issue" or "I'm done with #3" —
> honestly, whatever words come out of their mouth — and the agent just does
> all three. They shouldn't have to look up a specific command name for this.
>
> Can you make both of these work for anyone who installs our plugin?

---

## What you're given

The app exposes a small REST API while `npm run dev` is running:

- `GET  http://localhost:3000/api/issues` — list all issues
- `PATCH http://localhost:3000/api/issues/<id>` — update one
  (body: any subset of `title`, `description`, `status`, `assignee`)

A starter plugin lives in `plugin/`. It contains a bare manifest and one
helper script:

- `plugin/scripts/typecheck-gate.sh` — reads a Bash tool-call payload on
  stdin; if the command is a `git commit` it runs `npm run typecheck` and
  emits a deny decision when that fails. **It is not wired up to anything.**

You should not need to write any shell. Your job is to decide which plugin
building blocks solve each requirement and add them.

## Ground rules

- Everything you add must live inside `plugin/` so it ships with one install.
- Prove it works: introduce a type error, ask the agent to commit — watch it
  get blocked. Fix the error, tell the agent you're done with an issue in
  plain English, watch all three steps land on the board at
  http://localhost:3000.
