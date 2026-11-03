# Two-Tier Witness-Based Glob Intersection

We determine whether two Directives have overlapping Effective Scopes by testing their glob sets (`picomatch`) against the repository's actual file paths first, falling back to synthesized stem candidate paths only when a glob targets uncreated files. Standard glob libraries (`picomatch`, `minimatch`) evaluate `isMatch(path, glob)` rather than symbolic automata intersection over brace expansions and negations. Testing against real repository files executes in milliseconds, handles complex negated globs accurately, and produces a real repository Witness Path (e.g., `packages/api/src/router.ts`) for diagnostic output.

