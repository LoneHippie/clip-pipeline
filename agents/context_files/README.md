# Context Files

This folder holds **always-on** markdown context that is loaded into every agent's system prompt at runtime.

## Adding a new file

1. Drop `<NAME>.md` here.
2. Add the filename to the appropriate agent's `contextFiles` list in `context/registry.ts`.

## Files

| File | Purpose |
|---|---|
| `PIPELINE_OVERVIEW.md` | High-level description of the clip pipeline — loaded by all three agents |

> `README.md` itself is never auto-loaded.
