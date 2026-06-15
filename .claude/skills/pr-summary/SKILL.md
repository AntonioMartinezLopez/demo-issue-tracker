---
name: pr-summary
description: Summarize the current branch's changes for PR reviewers. Includes a structured overview, grouped change list, and Mermaid diagrams where useful. User-invocable only.
disable-model-invocation: true
context: fork
allowed-tools: Bash(git *)
---

# PR Summary

## Context

- Current branch: !`git branch --show-current`
- Commits on this branch vs main: !`git log --oneline main..HEAD`
- Files changed vs main: !`git diff --stat main..HEAD`
- Full diff vs main: !`git diff main..HEAD`

## Your task

Write a PR summary that helps a reviewer quickly understand what changed and why. Structure it as follows:

### 1. Overview (2–4 sentences)
What is the purpose of this PR? What problem does it solve or what feature does it add? Be concrete — name the components, endpoints, or flows that changed.

### 2. Changes

Group the changed files into logical areas (e.g. "API", "UI", "Data layer", "Config"). For each group:
- List the files changed
- Explain what changed and the intent behind it

Use concise bullet points. Skip obvious renamings or trivial formatting changes unless they have significance.

### 3. Mermaid Diagrams (only if genuinely useful)

Include one or more Mermaid diagrams **only** when they clarify something that prose cannot — for example:
- A new or changed data flow between components
- A modified API sequence
- A state machine or status transition change
- New or removed relationships between modules

Skip diagrams for simple, self-contained changes. When in doubt, omit.

Example diagram types to consider:
```
flowchart LR / TD
sequenceDiagram
stateDiagram-v2
erDiagram
```

### 4. Notes for Reviewers

Call out anything that warrants extra attention:
- Non-obvious design decisions
- Trade-offs made
- Areas with known limitations
- Anything that deviates from the usual project patterns

If there is nothing notable, omit this section entirely.

---

Output the summary as clean Markdown, ready to paste into a PR description. Do not add meta-commentary about your process.
