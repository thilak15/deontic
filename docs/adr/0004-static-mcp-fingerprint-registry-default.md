# Static MCP Fingerprint Registry by Default with Opt-In Live Probe

We profile MCP tool schemas and token budgets during `deontic check` and `deontic cost` using an embedded static fingerprint registry of known MCP servers by default, gating live JSON-RPC `tools/list` process spawning behind `deontic mcp-probe` (or `--probe`). Spawning local stdio MCP servers on every lint run would introduce network/process startup latency, fail in CI when server API keys are absent, and execute untrusted third-party commands unexpectedly during static analysis.

