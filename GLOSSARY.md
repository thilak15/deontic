# Deontic

Static analysis, budget profiling, and synchronization of AI coding agent instructions and tool configurations across a software repository.

## Language

### Artifacts & Structure

**Harness File**:
Any instruction document or tool-configuration file in a repository that shapes an AI coding agent's context or toolset.
_Avoid_: Agent file, rule file, memory file, prompt file

**Agent Profile**:
The specific combination of Harness Files and scope-loading rules that a single AI coding tool (such as Claude Code, Cursor, or Codex) activates during a session.
_Avoid_: Tool mode, target harness, client config

**Rule Section**:
A cohesive, heading-delimited or frontmatter-scoped block within a Harness File that groups related guidance and serves as the unit of progressive disclosure and usage tracking.
_Avoid_: Rule, chunk, block, module

**Directive**:
An atomic imperative statement (`MUST`, `MUST_NOT`, `SHOULD`, `SHOULD_NOT`) that constrains how an agent writes code, runs commands, or uses tools.
_Avoid_: Instruction, rule, requirement, command

**Context Note**:
A non-imperative descriptive statement, architecture overview, or directory tree in a Harness File that consumes context budget without imposing a behavioral constraint.
_Avoid_: Info directive, informational rule, passive instruction

**Derivable Directory Tree**:
A Context Note consisting of an ASCII file tree or a pure path-catalog list that duplicates repository structure an agent can discover directly from the filesystem.
_Avoid_: File map, repo outline

**Checkout Boundary**:
A directory root representing an independent repository checkout or Git worktree nested within or alongside the workspace being audited.
_Avoid_: Sub-repo, nested clone, worktree folder


### Scope & Diagnostics

**Effective Scope**:
The set of repository file paths where a Directive or Rule Section is active when an agent reads or edits code.
_Avoid_: Active path, target glob, rule coverage

**Turn-0 Load**:
The baseline tokens, Directives, and tool schemas injected into an agent's context window at session start before any repository file is opened.
_Avoid_: Startup cost, initial prompt size, static token tax

**Same-Scope Contradiction**:
A conflict between two Directives with incompatible obligations or mutually exclusive targets whose Effective Scopes overlap without a hierarchical parent-child override relationship.
_Avoid_: Rule collision, flat conflict

**Unscoped Ancestor Override**:
A conflict where a narrower child Harness File intentionally reverses a Directive from an always-loaded ancestor Harness File, leaving both conflicting Directives visible in the agent's context window simultaneously.
_Avoid_: Implicit override, inheritance bug, shadow rule

**Dead Reference**:
A repository file path, directory, script, or import mentioned in a Harness File that no longer exists in the workspace and is not a template placeholder, build artifact, or prohibited historical path.
_Avoid_: Broken link, stale path

**Dead Rule Section**:
A Rule Section repeatedly loaded into agent sessions whose Effective Scope or referenced domain files are never touched during those sessions.
_Avoid_: Dead rule, unused instruction, zero-hit rule

**Witness Path**:
A concrete repository file path (or synthesized candidate path when no matching file exists yet) that falls within the Effective Scopes of two conflicting Directives, proving their scopes overlap.
_Avoid_: Counterexample glob, collision path, overlap sample

**Parameter Casing Collision**:
A schema inconsistency across active MCP tools where the same conceptual parameter name appears with different casing conventions (such as `repo_name` vs. `repoName`).
_Avoid_: Schema conflict, argument mismatch

**Session Hit Rate**:
The percentage of recorded local agent sessions in which the agent touches at least one file or runs at least one command matching a Rule Section's scope.
_Avoid_: Rule usage count, activation score

**Diagnostic Group**:
A single consolidated finding anchored on one canonical primary location that aggregates all duplicate or related occurrences as secondary locations underneath it.
_Avoid_: Cluster, deduplicated warning, bundled error



