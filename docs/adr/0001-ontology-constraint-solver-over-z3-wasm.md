# Pure-TypeScript Ontology and Finite-Domain Solver over Z3 WASM

We resolve Directive contradictions using a deterministic, pure-TypeScript domain ontology and finite-domain constraint solver rather than bundling `z3-solver` (WASM). In real-world Harness Files, contradictions stem from lexical and taxonomic relationships (`Prisma` as a subtype of `database`, `Testcontainers` entailing `Docker`, `pnpm` vs. `npm` mutual exclusion) rather than deep multi-variable boolean satisfiability formulas. A pure-TypeScript ontology + entailment engine resolves polarity, subtype, and mutual-exclusion conflicts in under 5ms with zero cold-start latency and avoids a ~20MB+ WASM binary in the CLI distribution.

