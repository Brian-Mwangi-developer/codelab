# Codelab — Architecture

## System Overview

Codelab is a VS Code extension that extracts, enforces, and evolves engineering patterns across a codebase. It uses Claude Code CLI as its AI backbone, orchestrating sub-agents for large-scale analysis.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                        │
│                                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Activity  │  │  Pattern     │  │ Conformance  │  │   Deep      │ │
│  │ Bar Icon  │  │  Issues      │  │  Guard       │  │  Analysis   │ │
│  │          │  │  TreeView    │  │  (git hook)  │  │  TreeView   │ │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│       │               │                 │                  │        │
│  ┌────┴───────────────┴─────────────────┴──────────────────┴──────┐ │
│  │                    Extension Core (extension.ts)                │ │
│  │  Commands · Providers · State Management · Event Listeners     │ │
│  └────┬──────────┬──────────┬──────────┬──────────┬──────────────┘ │
│       │          │          │          │          │                  │
│  ┌────┴───┐ ┌───┴────┐ ┌──┴───┐ ┌───┴────┐ ┌──┴──────────────┐  │
│  │ File   │ │Persist-│ │Prompt│ │Diagnos-│ │  Agent          │  │
│  │Collect-│ │ ence   │ │Engine│ │tics /  │ │  Orchestrator   │  │
│  │ or     │ │Manager │ │      │ │Hover / │ │                 │  │
│  │        │ │        │ │      │ │Actions │ │  ┌───────────┐  │  │
│  └────────┘ └────────┘ └──────┘ └────────┘ │  │ Claude    │  │  │
│                                             │  │ CLI       │  │  │
│                                             │  │ Bridge    │  │  │
│                                             │  └─────┬─────┘  │  │
│                                             └────────┼────────┘  │
└──────────────────────────────────────────────────────┼───────────┘
                                                       │
                          ┌────────────────────────────┼──────────────┐
                          │        Claude Code CLI Layer               │
                          │                                            │
                          │   ┌─────────┐  ┌──────────────────────┐   │
                          │   │ Direct  │  │  Sub-Agent Pool      │   │
                          │   │ Session │  │                      │   │
                          │   │(sonnet) │  │  ┌──────┐ ┌──────┐  │   │
                          │   │         │  │  │haiku │ │haiku │  │   │
                          │   │         │  │  │chunk1│ │chunk2│  │   │
                          │   │         │  │  └──────┘ └──────┘  │   │
                          │   │         │  │  ┌──────┐ ┌──────┐  │   │
                          │   │         │  │  │haiku │ │haiku │  │   │
                          │   │         │  │  │chunk3│ │chunk4│  │   │
                          │   │         │  │  └──────┘ └──────┘  │   │
                          │   └─────────┘  └──────────────────────┘   │
                          │                                            │
                          │   ┌────────────────────────────────────┐   │
                          │   │  Deep Analysis Orchestrator (opus) │   │
                          │   │  └─► sub-agents (sonnet) per area  │   │
                          │   └────────────────────────────────────┘   │
                          └────────────────────────────────────────────┘

                          ┌────────────────────────────────────────────┐
                          │        .codelab/ (Persistent Storage)       │
                          │                                            │
                          │  patterns.md          ← compiled patterns  │
                          │  CLAUDE.md            ← rules for Claude   │
                          │  .cursorrules         ← rules for Cursor   │
                          │  conformance.json     ← cached issues      │
                          │  settings.json        ← extension settings │
                          │  patterns/                                  │
                          │    ├── chunk-001.md   ← sub-agent findings │
                          │    ├── chunk-002.md                        │
                          │    └── ...                                  │
                          │  analysis/                                  │
                          │    ├── redundancy.md                       │
                          │    ├── performance.md                      │
                          │    ├── implementation.md                   │
                          │    └── summary.md     ← compiled analysis  │
                          └────────────────────────────────────────────┘
```

## Core Components

### 1. File Collector (`fileCollector.ts`)
Unchanged from current. Walks workspace, respects ignores, returns file contents.

### 2. Agent Orchestrator (`agentOrchestrator.ts`) — NEW
The brain of the system. Decides HOW to run Claude based on codebase size:

| Files | Strategy | Model |
|-------|----------|-------|
| ≤ 50 | Single session | sonnet |
| 51–500 | Chunked parallel sub-agents | haiku (workers) + sonnet (compiler) |
| 500+ | Chunked parallel + batched | haiku (workers) + sonnet (compiler) |

**Responsibilities:**
- Chunks files into batches (by directory or file count)
- Spawns parallel `claude --print --model haiku` sub-agents
- Each sub-agent writes to `.codelab/patterns/chunk-NNN.md`
- Compiler pass (sonnet) reads all chunks → produces final `patterns.md`
- Reports progress back to VS Code

### 3. Persistence Manager (`persistenceManager.ts`) — NEW
Manages `.codelab/conformance.json` and `.codelab/settings.json`.

**conformance.json structure:**
```json
{
  "version": 1,
  "timestamp": "2026-03-18T10:00:00Z",
  "patternsHash": "sha256:abc...",
  "issues": [
    {
      "file": "src/foo.ts",
      "line": 10,
      "column": 0,
      "severity": "warning",
      "message": "...",
      "rule": "...",
      "suggestion": "...",
      "fileHash": "sha256:def..."
    }
  ]
}
```

**Invalidation rules:**
- Per-file: if `fileHash` changes, discard that file's issues
- Global: if `patternsHash` changes, discard all issues
- On reload: load from disk, validate hashes, show surviving issues

**settings.json structure:**
```json
{
  "pushGuardEnabled": false,
  "autoCheckOnSave": false,
  "subAgentThreshold": 50,
  "deepAnalysisModel": "opus"
}
```

### 4. Real-time Watcher (`fileWatcher.ts`) — NEW
Listens to `vscode.workspace.onDidSaveTextDocument`:
- Re-reads the saved file
- Compares against cached issues for that file
- For each issue: checks if the line content has changed → removes resolved issues
- Updates all providers (tree, diagnostics, hover, code actions)
- Persists updated state to `conformance.json`

Does NOT re-run Claude on every save — that would be expensive. Instead it does lightweight local checks:
- Line deleted or substantially changed → issue likely resolved
- If user wants a full re-check, they click Refresh

### 5. Git Push Guard (`gitGuard.ts`) — NEW
Two approaches (we use approach A):

**Approach A: Pre-push hook (installed by extension)**
- When enabled: writes `.git/hooks/pre-push` that reads `.codelab/conformance.json`
- If errors exist → exits non-zero with message "Codelab: N conformance errors. Resolve before pushing."
- When disabled: removes the hook
- Toggle button in the sidebar view title bar

**Why not approach B (intercept in extension)?**
VS Code doesn't expose git push events. The git hook is the reliable way.

### 6. Deep Analysis Engine (`deepAnalysis.ts`) — NEW
A separate, heavier process invoked by its own button. Uses Opus as orchestrator.

**What it finds:**
- **Redundancy** — Duplicate logic, copy-pasted code, functions that do the same thing
- **Implementation Issues** — Race conditions, blocking threads, deadlocks, incorrect async patterns
- **Performance Overhead** — Expensive operations in hot paths, N+1 queries, unnecessary re-renders, large bundle imports
- **Security Concerns** — Injection risks, hardcoded secrets, insecure defaults

**Orchestration:**
```
Opus (orchestrator)
  ├── Sonnet agent: Redundancy analysis → .codelab/analysis/redundancy.md
  ├── Sonnet agent: Implementation review → .codelab/analysis/implementation.md
  ├── Sonnet agent: Performance audit → .codelab/analysis/performance.md
  └── Sonnet agent: Security scan → .codelab/analysis/security.md
         │
         ▼
Opus compiles → .codelab/analysis/summary.md
```

Results shown in a **second TreeView** ("Deep Analysis") below Pattern Issues.

### 7. Prompt Engine (`prompt.ts`) — EXPANDED
All prompts centralized. Now includes:
- Pattern extraction (single + chunked sub-agent variant)
- Pattern compilation (merge sub-agent outputs)
- Agent file generation (CLAUDE.md, .cursorrules)
- Conformance checking (single + chunked)
- Deep analysis prompts (per-area + compilation)

### 8. UI Components

**Activity Bar:**
- Codelab icon → opens sidebar

**Sidebar (ViewContainer: `codelab-sidebar`):**
- **View 1: Pattern Issues** — conformance violations, grouped by file
- **View 2: Deep Analysis** — analysis findings, grouped by category
- **View title buttons:**
  - Refresh (re-run conformance)
  - Check Conformance (run)
  - Push Guard toggle (lock/unlock icon)
  - Run Deep Analysis (beaker/microscope icon)

**Editor integration:**
- Diagnostics (squiggly lines)
- Hover cards (rule + suggestion + link to patterns.md)
- Code Actions / Lightbulb (quick-fix suggestions)

**Status bar:**
- "Extract Patterns" button (existing)
- Issue count indicator (e.g., "⚠ 5 issues")

## Data Flow

### Pattern Extraction (large codebase)
```
collectFiles() → 200 files
        │
        ▼
chunkFiles(files, 30) → 7 chunks
        │
        ▼
spawn 7x `claude --print --model haiku` in parallel
  each writes .codelab/patterns/chunk-NNN.md
        │
        ▼
all complete → spawn `claude --print --model sonnet`
  reads all chunk files → writes patterns.md
        │
        ▼
spawn `claude --print --model sonnet`
  reads patterns.md → writes CLAUDE.md + .cursorrules
```

### Conformance Check (with persistence)
```
loadConformance() ← .codelab/conformance.json
        │
   valid cache? ──yes──► show cached issues
        │
        no
        ▼
collectFiles() + read patterns.md
        │
        ▼
spawn claude (chunked if needed) → JSON issues
        │
        ▼
saveConformance() → .codelab/conformance.json
        │
        ▼
updateProviders(issues) → tree + diagnostics + hover + actions
```

### Real-time Update (on file save)
```
onDidSaveTextDocument(doc)
        │
        ▼
read current issues for doc.relativePath
        │
        ▼
for each issue:
  read line content at issue.line
  if line changed significantly → mark resolved
        │
        ▼
update providers with filtered issues
persist to conformance.json
```

## File Structure (target)

```
src/
├── extension.ts              # Entry point, wires everything
├── fileCollector.ts           # Workspace file walker
├── agentOrchestrator.ts       # Chunking + parallel sub-agent management
├── claudeIntegration.ts       # Low-level Claude CLI bridge
├── prompt.ts                  # All prompt templates
├── conformanceChecker.ts      # Conformance logic (uses orchestrator)
├── deepAnalysis.ts            # Deep analysis engine (Opus orchestrated)
├── persistenceManager.ts      # Read/write .codelab/*.json
├── fileWatcher.ts             # Real-time issue resolution on save
├── gitGuard.ts                # Pre-push hook install/remove
├── issuesTreeProvider.ts      # TreeView for conformance issues
├── analysisTreeProvider.ts    # TreeView for deep analysis findings
├── diagnosticsProvider.ts     # Inline squiggles
├── hoverProvider.ts           # Hover cards
├── codeActionProvider.ts      # Lightbulb fixes
└── test/
    └── extension.test.ts

media/
└── codelab-icon.svg           # Activity bar icon (grayscale)

.codelab/                      # Generated per-project (gitignore-able)
├── patterns.md
├── CLAUDE.md
├── .cursorrules
├── conformance.json
├── settings.json
├── patterns/
│   ├── chunk-001.md
│   └── ...
└── analysis/
    ├── redundancy.md
    ├── performance.md
    ├── implementation.md
    ├── security.md
    └── summary.md
```
