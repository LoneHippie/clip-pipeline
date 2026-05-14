# Multi-Phase Agent Architecture

This document describes a reusable architecture for building multi-phase AI
agents on top of the Vercel AI SDK (`ai` package) with model providers like
`@ai-sdk/anthropic`. It is written as a guide for another AI agent: given this
document and a target agent specification, you should be able to design,
scaffold, and orchestrate a new agent that fits the same architecture.

The architecture is **agnostic** — it describes the shape of the system, not
the specific roles, tools, skills, or context files that a particular agent
implementation chooses. Concrete examples are illustrative only.

---

## 1. Mental Model

An "agent" in this architecture is **not** a single LLM call. It is an
**orchestrated pipeline of phases**, where each phase is itself a constrained
sub-agent powered by `generateText` from the AI SDK.

The top-level structure is:

```diagram
╭────────────────────────────────────────────────────────────╮
│                       runAgent(props)                      │
│                                                            │
│   ╭──────────────╮                                         │
│   │ buildContext │  ← loads system prompt + static files   │
│   ╰──────┬───────╯    + dynamic external data (tickets…)   │
│          │                                                 │
│          ▼                                                 │
│   ╭──────────────╮   ╭──────────────╮   ╭──────────────╮   │
│   │   Phase 1    │──▶│   Phase 2    │──▶│   Phase N    │   │
│   │  (generate   │   │  (generate   │   │  (generate   │   │
│   │   Text loop) │   │   Text loop) │   │   Text loop) │   │
│   ╰──────────────╯   ╰──────────────╯   ╰──────────────╯   │
│          │                  │                  │           │
│          ▼                  ▼                  ▼           │
│        onChunk            onChunk            onChunk       │
│       (streaming)        (streaming)        (streaming)    │
╰────────────────────────────────────────────────────────────╯
```

Key design properties:

- Each **phase** is a focused sub-agent with a narrow system prompt and a
  curated subset of tools.
- Each phase runs an **agentic loop** (multi-step tool use) bounded by a
  `maxSteps` budget.
- Phases are **chained sequentially**. The text output of one phase is fed
  verbatim, as a labeled section, into the next phase's prompt.
- All progress is streamed to the caller through a single **`onChunk`
  callback** with a structured chunk type.
- **Skills** (on-demand markdown knowledge) are loaded by a special tool, not
  injected into the system prompt by default.
- **Context** (always-on knowledge) is loaded once at the start and merged
  into every phase's effective prompt via the shared base prompt.

---

## 2. Top-Level Folder Layout

```diagram
agents/
├── index.ts                  # Public entry point: runAgent(...) + types
├── phases/                   # Phase definitions + orchestration types
│   ├── index.ts              # Barrel: exports phase factories + types
│   ├── types.ts              # PhaseConfig, PhaseResult, PipelineInput, etc.
│   ├── <phase-a>.ts          # createPhaseA(): PhaseConfig
│   ├── <phase-b>.ts          # createPhaseB(): PhaseConfig
│   └── ...
├── tools/                    # Tool implementations grouped by domain
│   ├── index.ts              # Barrel: re-exports tool sets
│   ├── fileTools.ts          # e.g. read/edit/grep/glob/bash
│   ├── gitTools.ts           # e.g. clone/branch/commit/push
│   ├── <domainX>Tools.ts     # any external system or API
│   └── ...
├── skills/                   # On-demand markdown skills + loader tool
│   ├── index.ts              # skillTool definition + AVAILABLE_SKILLS list
│   ├── <skill-1>.md
│   ├── <skill-2>.md
│   └── ...
├── context/                  # System prompt construction
│   ├── index.ts              # Barrel
│   ├── types.ts              # AgentName, AgentContextConfig, LoadedContext
│   ├── registry.ts           # AgentName → base prompt + context file lists
│   ├── loader.ts             # buildSystemPrompt(input): LoadedContext
│   └── <externalSource>.ts   # optional: dynamic context fetchers (e.g. tickets)
├── context_files/            # Static markdown context (always-on)
│   ├── README.md
│   ├── <PROJECT>_OVERVIEW.md
│   └── repo_specific/        # optional: per-repo or per-target context
│       └── <REPO>_OVERVIEW.md
└── utils/
    └── index.ts              # Shared helpers (logging fetch, prompts, etc.)
```

When designing a new agent, **preserve this layout**. Each top-level folder
has a single, well-defined responsibility and the orchestrator in `index.ts`
depends on the public API of each.

---

## 3. The Phase Abstraction (`phases/`)

A phase is the atomic unit of agent work. It is described by a single config
object and produced by a factory function.

### 3.1 `PhaseConfig`

```ts
import type { ToolSet } from "ai";

export type PhaseName = "<name-1>" | "<name-2>" | "...";

export interface PhaseConfig {
  name: PhaseName;
  systemPrompt: string;   // the phase's role-specific instructions
  tools: ToolSet;         // curated subset of tools this phase may use
  maxSteps: number;       // upper bound on agentic loop iterations
}

export interface PhaseResult {
  phase: PhaseName;
  output: string;         // the final text the model produced
  toolCallCount: number;  // bookkeeping for observability
}
```

### 3.2 Phase Factory Pattern

Every phase lives in its own file and exports a `create<Name>Phase()` factory
that returns a `PhaseConfig`. Factories take no required arguments — they are
pure config builders. This keeps phases easy to compose and test.

```ts
// phases/<phase-name>.ts
import type { PhaseConfig } from "./types";
import { fileTools, gitTools /* ... */ } from "../tools";

const systemPrompt = `You are the <Role> Agent in a <pipeline> pipeline.
...
## Your Responsibilities
1. ...
2. ...

## Output Format
[Strict, machine-friendly markdown structure that downstream phases can parse]

## Rules
- Do NOT do <things outside this phase's scope>
- ...
`;

export function create<Name>Phase(): PhaseConfig {
  return {
    name: "<phase-name>",
    systemPrompt,
    tools: {
      // Pick tools by name from each tool set; do NOT spread an entire tool
      // set unless the phase truly needs everything.
      readFile: fileTools.readFile,
      grep: fileTools.grep,
      // ...
    },
    maxSteps: 30,
  };
}
```

### 3.3 Designing Good Phases

When you split work into phases, follow these rules:

1. **One verb per phase.** Each phase should map to a single, coherent verb
   (the verbs depend entirely on the agent's purpose — e.g. *gather*,
   *analyze*, *transform*, *validate*, *deliver*, *summarize*). If a phase
   is doing more than one verb, split it.
2. **Read-only vs. write phases.** Be explicit. A read-only phase must not
   receive any mutating tools. Build a `readOnlyXTools` object at the top of
   the phase file by destructuring the relevant safe subset.
3. **Curated tools, not blanket access.** Each phase's `tools` map should
   include only what that phase needs. This both reduces surface area for
   mistakes and serves as documentation of intent.
4. **Strict output contract.** The `systemPrompt` must demand a structured
   markdown output with named sections. Downstream phases consume this output
   verbatim — vague output breaks the pipeline.
5. **Explicit "Rules" section.** End each system prompt with a `## Rules`
   list that names what the phase **must not** do. Negative constraints are
   often more important than positive instructions.
6. **`maxSteps` is a budget, not a target.** Set it slightly above the
   typical worst case for that phase. Read-only phases need fewer steps;
   implementation phases need more.

### 3.4 Phase Barrel (`phases/index.ts`)

The barrel re-exports every factory and every type. The orchestrator imports
from `./phases`, never from individual phase files. This makes adding or
removing phases a one-line change.

```ts
export { createPhaseA } from "./phaseA";
export { createPhaseB } from "./phaseB";
// ...
export type { PhaseName, PhaseConfig, PhaseResult, PipelineInput } from "./types";
```

---

## 4. The Tools Layer (`tools/`)

Tools are the **only** way phases can affect the world. They are defined with
the AI SDK's `tool({ description, inputSchema, execute })` helper using `zod`
for input validation.

### 4.1 Tool Set Pattern

Each domain (filesystem, git, an external API, a SaaS integration, etc.)
gets its own file that exports a single object whose keys are tool names and
whose values are `tool(...)` instances:

```ts
// tools/<domain>Tools.ts
import { tool } from "ai";
import { z } from "zod";

export const <domain>Tools = {
  doThing: tool<{ arg: string }, string>({
    description: "Clear, model-facing description. Mention edge cases.",
    inputSchema: z.object({
      arg: z.string().describe("What this argument is for"),
    }),
    execute: async ({ arg }) => {
      // perform side effect, return a string the model can read
    },
  }),
  // ...more tools in the same domain
};
```

### 4.2 Tools Barrel (`tools/index.ts`)

Re-export every tool set. Phases pick tools out of these sets by name.

```ts
export { fileTools } from "./fileTools";
export { gitTools } from "./gitTools";
export { <domain>Tools } from "./<domain>Tools";
```

### 4.3 Designing Good Tools

- **Descriptions are prompts.** The `description` field is read by the LLM at
  every invocation. Be concrete: list when to use it, when not to use it,
  pitfalls, and any required argument formats.
- **Use `zod` for every argument** with `.describe(...)` on each field. The
  description text appears in the tool schema the model sees.
- **Return strings, not objects.** Tool results are surfaced to the model as
  text. If you need structure, return JSON-stringified content with a brief
  human-readable header.
- **Return errors as text, not exceptions.** Begin error returns with
  `"Error: "` so the model can recognize and react. Throwing inside
  `execute` aborts the step.
- **One tool per concrete operation.** Resist the temptation to make a
  single mega-tool with a `mode` argument. Smaller tools with sharper
  descriptions yield better tool selection.
- **Group by domain, not by phase.** A tool is reusable across phases; a
  phase composes the tools it needs. Never write a "phase-specific" tool
  file.

---

## 5. The Skills Layer (`skills/`)

Skills are **markdown documents that the model can pull on demand** through
a single tool. They are the right place for procedural, conventional, or
domain-specific knowledge that is too long to live in every system prompt
but too important to forget.

### 5.1 The `loadSkill` Tool

```ts
// skills/index.ts
import { tool } from "ai";
import { z } from "zod";
import path from "path";

const SKILLS_DIR = path.join(import.meta.dir);

const AVAILABLE_SKILLS = [
  "<skill-name-1>",
  "<skill-name-2>",
  // ...
] as const;

type SkillName = (typeof AVAILABLE_SKILLS)[number];

const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  "<skill-name-1>": "Short description of when to load this skill",
  // ...
};

export const skillTool = tool({
  description: `Load domain-specific knowledge or procedures on demand. Available skills:\n${AVAILABLE_SKILLS.map(
    (s) => `  - ${s}: ${SKILL_DESCRIPTIONS[s]}`
  ).join("\n")}`,
  inputSchema: z.object({
    name: z.enum(AVAILABLE_SKILLS).describe("Name of the skill to load"),
  }),
  execute: async ({ name }) => {
    try {
      const filePath = path.join(SKILLS_DIR, `${name}.md`);
      return await Bun.file(filePath).text();
    } catch {
      return `Skill "${name}" not found or could not be loaded.`;
    }
  },
});
```

The orchestrator merges `loadSkill` into **every phase's** tool map (see
§7.2). This means any phase can ask for any skill at any step, but does not
pay the prompt-length cost unless it actually needs the knowledge.

### 5.2 Writing Effective Skills

A skill is a short, dense markdown file. Treat it like a one-page reference
card a senior engineer would hand a junior:

- **Title is the skill name** — `# <Skill Name>` as the first line.
- **Use sections.** Common sections: an overview/when-to-use, numbered
  procedural steps, "Common Patterns" or "Common Pitfalls" lists, "Rules" or
  "Guidelines".
- **Be prescriptive, not descriptive.** Use imperative verbs ("Run X",
  "Always Y", "Never Z"). The model needs decisions, not narration.
- **Keep it short.** 20–80 lines is typical. If a skill grows long, split it
  into two skills with a narrower scope each.
- **No code that depends on hidden context.** If you include code blocks,
  they should be self-contained snippets the model can adapt.
- **Use the same vocabulary as the tool descriptions.** If a tool is called
  `commitChanges`, refer to it by that name in any procedural step.

### 5.3 Adding a New Skill

1. Drop `<new-skill>.md` into `skills/`.
2. Add `"<new-skill>"` to the `AVAILABLE_SKILLS` tuple in `skills/index.ts`.
3. Add a one-line description to `SKILL_DESCRIPTIONS`.

No phase wiring is needed — skills are universally accessible via the shared
`loadSkill` tool.

---

## 6. The Context Layer (`context/` + `context_files/`)

While **skills** are pulled on demand, **context** is loaded once and
prepended to every phase's prompt. Context is for "always-on" knowledge:
high-level overviews, domain documentation, the user's specific request,
and any dynamically fetched external data the agent needs from the start.

> ⚠️ **The shape of the context layer is generic; the *sources* are not.**
> The patterns below — a registry, a loader, optional dynamic fetchers — are
> the agnostic primitives. The specific things you put in the registry and
> the specific external systems you fetch from are entirely up to the agent
> you are designing. Do not assume any particular external system, taxonomy,
> or selector key (such as repositories, tickets, projects, accounts, etc.).

### 6.1 Module Roles

| Module                | Responsibility                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| `context/types.ts`    | `AgentName`, `AgentContextConfig`, `LoadedContext`, input type              |
| `context/registry.ts` | Per-agent configuration: base prompt + which static context files to load   |
| `context/loader.ts`   | Generic engine: reads configured files, calls configured fetchers, formats  |
| `context/<source>.ts` | **Optional, agent-specific** fetchers for any dynamic context the agent needs |
| `context/index.ts`    | Public barrel                                                               |
| `context_files/`      | Static markdown that the loader reads                                       |

### 6.2 The Registry (Concept)

The registry is the single place where an `AgentName` is bound to:

1. The **base system prompt** describing what kind of agent it is.
2. The **list of static context file names** to load for that agent.
3. *(Optional)* Any secondary lookup tables that translate a runtime
   selector (whatever your agent's domain calls it) into additional file
   names — for example a key→files map for sub-domains, modes, targets,
   tenants, profiles, etc.

The exact shape of the registry depends entirely on the agent. The minimum
contract is a function the loader can call:

```ts
// context/registry.ts
const BASE_PROMPTS: Record<AgentName, string> = {
  "<agent-name>": "You are a <role> agent orchestrating a multi-phase pipeline...",
};

const CONTEXT_FILES: Record<AgentName, string[]> = {
  "<agent-name>": ["OVERVIEW.md", "GUIDELINES.md"],
};

export function getAgentConfig(agent: AgentName): AgentContextConfig {
  return { baseSystemPrompt: BASE_PROMPTS[agent], contextFiles: CONTEXT_FILES[agent] };
}
```

If the agent has a notion of a runtime selector (any kind of "which target
am I working on?" key), expose it as an additional pure function returning
file names — never bake the selector's *meaning* into the loader:

```ts
// Generic shape — the selector key is whatever the agent's domain calls for.
const SELECTOR_CONTEXT_FILES: Record<string, string[]> = {
  "<selector-value-A>": ["<A>_OVERVIEW.md"],
  "<selector-value-B>": ["<B>_OVERVIEW.md"],
};

export function getSelectorContextFiles(values: string[]): string[] {
  return values.flatMap((v) => SELECTOR_CONTEXT_FILES[v] ?? []);
}
```

The names `BASE_PROMPTS`, `CONTEXT_FILES`, and any selector map are
**examples of the pattern**, not a required vocabulary. Replace them with
names that fit the agent's domain.

### 6.3 The Loader (Generic Engine)

`buildSystemPrompt(input)` is the single function the orchestrator calls. Its
contract is the same regardless of agent:

```ts
export interface LoadedContext {
  systemPrompt: string;   // the fully assembled base prompt
  loadedFiles: string[];  // names of every file successfully loaded
  errors: string[];       // soft errors (file missing, fetch failed, etc.)
}
```

The loader itself should remain **generic**: it knows how to read files
from disk and how to call optional fetcher hooks, but it should not encode
the meaning of any specific external system. Conventions:

- **Never throw on missing files.** Record an error string and continue.
  Missing context should degrade behavior, not crash the pipeline.
- **Concatenate under named headings.** Use H1 sections (e.g. `# Project
  Context`, `# <Selector> Context`, `# <Source> Context: <ID>`) with H2
  sub-headings for each file. This is what the model will see, so structure
  it like a document, not a JSON blob. Section names should reflect the
  agent's own domain language.
- **Trim file contents.** Empty/whitespace files should be treated as
  missing.
- **Optional sources are always conditional.** Any dynamic fetcher only
  runs when its identifier is supplied via the input.
- **Keep agent-specific logic out of the loader body.** When the loader
  needs to invoke an agent-specific fetcher, do it through a thin
  conditional at the bottom of the function or via a hook list — not by
  hard-coding domain logic mid-function.

### 6.4 Dynamic Context Fetchers (Agent-Specific)

If your agent needs to pull in external data at run time — from any
external system — write a dedicated fetcher in its own file under
`context/` (e.g. `context/<sourceName>.ts`). Each fetcher is **specific to
the agent being built**; it is not part of the architecture's generic core.
Whether you need zero, one, or several such fetchers depends entirely on
the agent.

Every fetcher should follow the same shape so the loader can call it
uniformly:

1. Accept whatever identifier(s) the source needs, plus any optional
   credentials object.
2. Read fallback credentials from `process.env` if none are passed.
3. Return either a typed object or `null` on any failure (no throws).
4. Export a `format<X>Context(...)` function that turns the typed object
   into a markdown block ready to append to the system prompt.

This separation keeps the loader generic and lets each external source own
its own auth, parsing, and formatting logic. To support a new source for a
new agent, add a new `context/<sourceName>.ts` and a single conditional
block in the loader — no other file should need to know about it.

### 6.5 `context_files/`

This folder holds the **static** markdown context. Conventions:

- Use ALL_CAPS_WITH_UNDERSCORES file names for top-level overviews
  (`OVERVIEW.md`, `<DOMAIN>_GUIDELINES.md`).
- If the agent has a notion of variants/targets/sub-domains, group their
  context in a subfolder named after that concept (e.g. `<selector>_specific/`).
  The folder name is part of the agent's domain, not a fixed convention.
- Include a `README.md` explaining how to add new context files. This file
  is itself excluded from auto-loading.

---

## 7. The Orchestrator (`index.ts`)

The orchestrator is the public entry point of the agent. It does five things:

1. Builds the system prompt via `buildSystemPrompt`.
2. Constructs the model provider.
3. Composes the user-facing input into a `basePrompt`.
4. Runs each phase sequentially, passing the previous phase's output into the
   next phase's prompt.
5. Streams structured chunks to the caller and handles errors / cleanup.

### 7.1 Public Surface

```ts
export interface RunAgentProps {
  agent: AgentName;
  userInput: string;
  // ...any IDs or selectors the agent's context layer needs to load context.
  // What these are is entirely agent-specific — do not assume any default set.
  debug?: boolean;
  onChunk?: (chunk: AgentStreamChunk) => void;
  // Per-call credential overrides for whichever external integrations the
  // agent uses (model provider keys, API tokens, etc.). Optional; fall back
  // to environment variables inside the relevant fetcher/provider.
  modelProviderApiKey?: string;
  // ...other credential bundles
}

export type AgentStreamChunk =
  | { type: "phase-start"; phase: string; text: string }
  | { type: "phase-complete"; phase: string; text: string }
  | { type: "tool-call"; toolName: string; input: unknown; phase: string }
  | { type: "tool-result"; output: unknown; phase: string }
  | { type: "text-delta"; text: string; phase: string }
  | { type: "error"; message: string }
  | { type: "finish" };
```

The chunk schema is the contract with any UI or CLI consumer. Keep it stable.

### 7.2 The `runPhase` Helper

A private helper inside `index.ts` runs exactly one phase:

```ts
async function runPhase(
  phase: PhaseConfig,
  prompt: string,
  modelProvider: ReturnType<typeof createXProvider>,
  onChunk?: (chunk: AgentStreamChunk) => void,
  debug?: boolean,
): Promise<PhaseResult> {
  let toolCallCount = 0;

  onChunk?.({ type: "phase-start", phase: phase.name, text: `Starting ${phase.name} phase...` });

  // Skills are universally available — merge them in here, not in each phase.
  const toolsWithSkill = { ...phase.tools, loadSkill: skillTool };

  const result = await generateText({
    model: modelProvider("<model-id>"),
    system: phase.systemPrompt,
    prompt,
    tools: toolsWithSkill,
    stopWhen: stepCountIs(phase.maxSteps),
    onStepFinish: (step) => {
      toolCallCount += step.toolCalls.length;
      for (const toolCall of step.toolCalls) {
        onChunk?.({ type: "tool-call", toolName: toolCall.toolName, input: toolCall.input, phase: phase.name });
      }
      for (const toolResult of step.toolResults) {
        onChunk?.({ type: "tool-result", output: toolResult.output, phase: phase.name });
      }
    },
  });

  onChunk?.({ type: "text-delta", text: result.text, phase: phase.name });
  onChunk?.({ type: "phase-complete", phase: phase.name, text: `${phase.name} phase complete.` });

  return { phase: phase.name, output: result.text, toolCallCount };
}
```

Important details:

- **`stopWhen: stepCountIs(phase.maxSteps)`** turns `generateText` into a
  bounded agentic loop.
- **`onStepFinish`** is where streaming and observability happen; the chunk
  callback fires for every tool call and tool result of every step.
- **`loadSkill` is merged here**, not in `PhaseConfig.tools`. This guarantees
  every phase has skill access and prevents the per-phase tool maps from
  having to know about it.
- The phase's final text output is emitted as a `text-delta` chunk after the
  loop completes, so consumers can render it as the phase's "answer".

### 7.3 The Pipeline

The pipeline itself is just an `async` function that calls `runPhase` once
per phase, threading outputs forward:

```ts
const phase1Result = await runPhase(createPhase1(), basePrompt, provider, onChunk, debug);

const phase2Prompt = `## Phase 1 Output\n\n${phase1Result.output}\n\n---\n\n<instructions for phase 2>`;
const phase2Result = await runPhase(createPhase2(), phase2Prompt, provider, onChunk, debug);

const phase3Prompt = [
  `## Original Request\n\n${basePrompt}`,
  `## Phase 1 Output\n\n${phase1Result.output}`,
  `## Phase 2 Output\n\n${phase2Result.output}`,
  `---`,
  `<instructions for phase 3>`,
].join("\n\n");
const phase3Result = await runPhase(createPhase3(), phase3Prompt, provider, onChunk, debug);

// ...etc.
```

Conventions for phase-to-phase prompts:

- **Always label upstream outputs with H2 headings** (`## <Phase> Output`,
  `## Original Request`, etc.). This makes it visually obvious to the model
  what came from where.
- **Use `---` separators** between upstream context and the new phase's
  instructions.
- **End every prompt with explicit imperatives**: a single sentence telling
  the phase what it must do given the upstream context.
- **Pass the original `basePrompt`** to later phases when they need to
  cross-check against the user's original request — do not assume the
  earlier phases captured everything.

### 7.4 Error Handling and Cleanup

Wrap the pipeline in `try / catch / finally`:

- **`catch`** emits an `error` chunk with a useful message if `onChunk` was
  provided, otherwise logs to stderr. **Do not throw out of `runAgent`**;
  consumers depend on it to drive UI state.
- **`finally`** emits a single `finish` chunk so consumers can transition out
  of any "in progress" state. If running headlessly with no `onChunk`,
  `process.exit(0)` is acceptable here.

---

## 8. Utilities (`utils/`)

Anything that is shared across multiple subsystems goes here. Common
inhabitants:

- A `loggingFetch` wrapper that the model provider can use to log requests
  and responses when `debug` is on.
- An `askUserConfirmation` helper used by tools that take destructive
  actions.
- Small parsing/formatting helpers used by both tools and the loader.

Keep `utils/` focused: anything tied to a specific domain belongs in that
domain's folder, not here.

---

## 9. Designing a New Agent in This Architecture

Given a target agent specification (e.g. "build an agent that does X"), use
this checklist:

1. **Decompose the work into phases.**
   - List the verbs the agent must perform end-to-end.
   - Group strictly sequential, single-purpose verbs into phases.
   - Decide read-only vs. write capability for each phase.
2. **Define `AgentName` and the registry entry.**
   - Add the new name to `AgentName` in `context/types.ts`.
   - Add a base prompt and context file list to `context/registry.ts`.
3. **Add static context.**
   - Drop any always-on markdown into `context_files/` (and a subfolder if
     it is target-specific).
   - List the file names in the registry's `CONTEXT_FILES` map.
4. **Add dynamic context if needed.**
   - For any external system the agent needs to read at runtime, add a
     `context/<source>.ts` fetcher with a `format<X>Context` companion.
   - Wire it into `loader.ts` behind a conditional on its identifier.
5. **Author skills.**
   - For procedural knowledge that is too long for a system prompt but
     should be available on demand, write short markdown skills.
   - Register them in `skills/index.ts` (`AVAILABLE_SKILLS` +
     `SKILL_DESCRIPTIONS`).
6. **Implement or reuse tools.**
   - For each new domain or external system the agent acts on, create
     `tools/<domain>Tools.ts` exporting an object of `tool({...})` entries.
   - Re-export from `tools/index.ts`.
7. **Write phase factories.**
   - For each phase, create `phases/<phase-name>.ts` exporting
     `create<Name>Phase(): PhaseConfig`.
   - Curate the tool subset, set `maxSteps`, and write a strict
     system prompt with a structured output contract and a `## Rules` list.
   - Re-export from `phases/index.ts` and add the name to `PhaseName` in
     `phases/types.ts`.
8. **Wire the orchestrator.**
   - In `index.ts`, call `buildSystemPrompt` with the new `AgentName`.
   - Call `runPhase` once per phase, threading outputs forward with labeled
     H2 sections and clear imperative tail instructions.
   - Stream every step through `onChunk`.

---

## 10. Anti-Patterns to Avoid

- **One giant phase with all tools.** Defeats the purpose of the
  architecture. Split into focused phases.
- **Phase-specific tools.** Tools are reusable; phases compose them. If a
  tool only makes sense for one phase, its description is probably too
  narrow.
- **Skills as system-prompt dumps.** If you find yourself loading the same
  skill in every step of a phase, it should probably move into that phase's
  `systemPrompt` instead.
- **Throwing from tools or fetchers.** Always return `"Error: ..."` strings
  or `null`; never abort the agent loop with an uncaught throw.
- **Free-form upstream output.** If a downstream phase has to guess where
  the previous phase's "verdict" or "plan" lives, the upstream phase's
  output contract is too loose. Tighten the `## Output Format` section.
- **Mutating the orchestrator instead of the registry.** New agents,
  context files, or skills should be added by editing data
  (`registry.ts`, `AVAILABLE_SKILLS`, `context_files/`), not by touching
  `runAgent`.
- **Hidden state between phases.** The only channel between phases is the
  string output of the previous phase plus the static context. Do not stash
  state in module-level variables.

---

## 11. Summary

This architecture is, in one sentence:

> **A registry-driven context loader feeds a sequence of bounded,
> tool-curated `generateText` phases, each emitting a strict markdown
> contract that becomes input to the next, with on-demand markdown skills
> available throughout, and all progress streamed through a structured
> chunk callback.**

If you are building a new agent on this foundation, your job is to:

- choose the phases,
- choose the tool subsets,
- choose the skills,
- choose the static and dynamic context,

and then let the orchestrator pattern in `index.ts` and the loader pattern
in `context/loader.ts` do the rest.
