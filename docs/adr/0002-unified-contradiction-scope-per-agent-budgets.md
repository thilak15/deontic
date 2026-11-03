# Unified Contradiction Scope with Per-Agent Context Budgets

We evaluate Directive contradictions (`CTX001`, `CTX003`) and Dead References (`CTX004`, `CTX005`) across a unified repository scope spanning all discovered Harness Files, while computing Turn-0 Load and Directive adherence cliffs (`CTX002`, `deontic cost`) separately per Agent Profile. Teams using multiple coding agents (or `deontic sync`) keep parallel Harness Files (`CLAUDE.md`, `.cursor/rules/*.mdc`, `AGENTS.md`) in the same repo: unified contradiction checking ensures developers on different tools never give their agents opposite rules for the same directory, while per-Agent-Profile budgeting prevents synced multi-tool repositories from double- or triple-counting tokens and Directives.

