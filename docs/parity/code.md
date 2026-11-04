# Code: parity with Claude Code, opencode and Codex CLI

What a person can do with a coding tool, and where Sub Rosa stands on each,
row by row. The rows are the fifty capabilities of the 2026-10-23 code plan,
grouped by family; the competitor columns are their documentation and
repositories on that date (Claude Code v2.1.3xx, opencode v1.19.4, Codex CLI).
Each row names the lot that closes it (`C0.1` to `C8.9`), then its pull
request or ADR once shipped.

`src/test/code-parity.test.ts` keeps this file honest: every row has a status
and a reference, every row still open names its lot, and the number of open
rows can only go down (`OPEN_CEILING` in the test). The plan is finished when
that number is zero.

Statuses: `done` (at parity or better, reachable in the shipped build) ·
`hidden` (the embedded runtime does it, but the app neither shows, enables nor
measures it) · `partial` · `todo` · `adapted` (the same need met differently,
said why) · `refused` (not taken, said why) · `external` (the app side is
done; the provider is asked for the rest). Open statuses are `hidden`,
`partial` and `todo`.

Competitor cells: `yes`, `partial`, `no`.

## Work loop

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Shell with streamed output | yes | yes | yes | hidden | C2.1, C2.4 |
| Background processes that wake the turn | yes | partial | partial | done | ADR-0016 |
| Subagents | yes | yes | yes | hidden | C3.3 |
| A team of roles (lead, builder, checks) | partial | no | no | partial | C7.1 to C7.7 |
| Visible task list | yes | yes | yes | hidden | C2.1 |
| Plan and build modes | yes | yes | partial | todo | C2.5 |
| Long objective (`/goal`) | yes | no | no | done | ADR-0016 |
| Steer during the turn, queue | yes | yes | partial | done | ADR-0016 |
| Doom loop detection | partial | yes | no | todo | C1.6 |

## Editing code

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Tolerant replacement | yes | yes | yes | hidden | C0.1, C2.1 |
| Edit format chosen per model family | no | yes | yes | partial | C1.4 |
| Formatter after an edit | partial | yes | no | todo | C1.3 |
| Language server diagnostics after an edit | partial | yes | no | hidden | C1.3 |
| An edit that does not parse is refused | no | no | no | partial | C1.3 |
| Structural search and rewrite | no | no | no | todo | C1.5 |

## Review and rewind

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Diff in the conversation | yes | yes | yes | todo | C2.1 |
| Keep or revert a file | partial | no | no | done | ADR-0090 |
| Keep or revert a hunk | partial | no | no | todo | C2.2 |
| Checkpoints per step and rewind | yes | yes | no | hidden | C1.1, C2.3 |
| Undo what the shell wrote | no | yes | no | todo | C1.1, C1.2 |

## Safety

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Rules by pattern (command, path) | yes | yes | yes | partial | C3.1 |
| Auto mode with a classifier | yes | no | yes | todo | C8.1 |
| File sandbox | yes | no | yes | partial | C2.5, C4.1 |
| Network sandbox (host list) | yes | no | yes | todo | C4.1 |
| Credential masking | yes | no | no | partial | C4.1 |
| Trust granted to the project | yes | no | yes | todo | C3.2 |
| Injection analysis on tool results | partial | no | no | hidden | C8.1 |

## Context

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| AGENTS.md and CLAUDE.md | yes | yes | yes | done | ADR-0014 |
| Compaction | yes | yes | yes | done | ADR-0006 |
| Large outputs kept out of context | yes | yes | yes | hidden | C1.6 |
| Repository map or index | no | no | no | todo | C8.3 |
| Memory across sessions | yes | no | partial | done | ADR-0009 |
| Other repositories as references | partial | yes | no | todo | C3.3 |

## Extensions

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| MCP with OAuth | yes | yes | yes | done | ADR-0092 |
| Skills (agentskills.io format) | yes | yes | yes | done | ADR-0006 |
| Project commands in files | yes | yes | yes | todo | C3.3 |
| User-defined hooks | yes | yes | partial | todo | C3.4 |
| Agents defined in files | yes | yes | yes | todo | C3.3 |

## Surfaces

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Integrated terminal | yes | yes | yes | todo | C2.4 |
| Reading code with highlighting | partial | partial | partial | partial | C2.6 |
| Git interface | partial | no | no | todo | C5.1 |
| Desktop application | yes | yes | yes | done | ADR-0090 |
| Following the work from the phone | yes | partial | partial | todo | C6.1 to C6.3 |
| Headless mode (CI, scripts) | yes | yes | yes | todo | C0.2 |
| Agent Client Protocol | partial | yes | partial | hidden | C4.3, C8.7 |
| GitHub (PR, review, action) | yes | yes | yes | partial | C5.2 |
| Parallel work in worktrees | yes | partial | partial | todo | C5.3 |

## Models and cost

| Capability | Claude Code | opencode | Codex CLI | Status | Where |
|---|---|---|---|---|---|
| Frontier coding models | partial | yes | partial | done | ADR-0090 |
| Confidential inference (TEE) | no | no | no | done | ADR-0017 |
| Budget ceiling per run | no | no | no | todo | C1.6 |
| Measured pass rate on a benchmark | no | no | no | todo | C0.1 |
