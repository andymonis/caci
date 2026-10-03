# Capabilities

One folder per thing the LLM component can do (`categorise/`, and later others such as answering).
Each folder holds that capability's own prompt, output guard and defaults, and is self-contained:

- It may use the shared kernel one level up (`../model-client`, `../errors`, `../usage`).
- It may use the graph store only through its public entry point (`../../graph_store/index.js`).
- It must **not** import another capability, so adding one never changes an existing one.

`src/llm/boundary.test.ts` enforces these rules.

The only files outside `capabilities/` that may import a capability are the assembly files, `src/llm/index.ts` and `src/llm/create-llm.ts`, which put the capabilities together into the public `createLlm()`.
