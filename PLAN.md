# Codelab — Implementation Plan

Reference: [ARCHITECTURE.md](ARCHITECTURE.md) for system overview, [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for detailed design.

## Current State (v0.2 — completed)

What exists today:
- [x] File collector with ignore logic
- [x] Single-session pattern extraction → `.codelab/patterns.md`
- [x] Agent file generation → `CLAUDE.md`, `.cursorrules`
- [x] Conformance checking → JSON issues from Claude
- [x] Sidebar TreeView (Pattern Issues)
- [x] Diagnostics (inline squiggles)
- [x] Hover cards (rule + suggestion)
- [x] Code action provider (lightbulb)
- [x] Activity bar icon (grayscale SVG)
- [x] Status bar "Extract Patterns" button

---

## Phase 1: Foundations (Persistence + Real-time + Model Selection)

**Goal:** Make the extension reliable and responsive. No new AI features — just infrastructure.

### Task 1.1: Model selection in Claude integration
- **File:** `src/claudeIntegration.ts`
- **Change:** Add `model` parameter to `runClaudeAnalysis()`, default `'sonnet'`
- **Risk:** Low — additive change
- **Test:** Extract patterns with explicit model, verify CLI args

### Task 1.2: Persistence manager
- **New file:** `src/persistenceManager.ts`
- **What:**
  - `saveConformance(issues, patternsHash)` → writes `.codelab/conformance.json`
  - `loadConformance()` → reads + validates hashes → returns valid issues
  - `saveSettings(settings)` / `loadSettings()` → `.codelab/settings.json`
  - SHA-256 hashing via Node.js `crypto` module
- **Change `conformanceChecker.ts`:** Add `originalLineText` + `fileHash` to issues
- **Change `extension.ts`:** Load on activate, save after check
- **Risk:** Medium — must handle corrupt/missing files gracefully
- **Test:** Run check → reload window → issues survive

### Task 1.3: Real-time file watcher
- **New file:** `src/fileWatcher.ts`
- **What:**
  - Listen to `onDidSaveTextDocument`
  - Compare saved line text vs `originalLineText`
  - Remove resolved issues, update providers, persist
  - Debounced (300ms)
- **Change `extension.ts`:** Register watcher in `activate()`
- **Risk:** Low — worst case is a false negative (issue stays when it shouldn't)
- **Test:** Create an issue → fix the line → save → issue disappears

---

## Phase 2: Git Guard + Settings UI

**Goal:** Prevent sloppy code from being pushed.

### Task 2.1: Git push guard
- **New file:** `src/gitGuard.ts`
- **What:**
  - `installPushGuard(rootPath)` — writes `.git/hooks/pre-push` with signature
  - `removePushGuard(rootPath)` — removes hook (only if ours)
  - `isPushGuardInstalled(rootPath)` — checks for signature comment
  - Hook script: reads `conformance.json`, counts errors, exits non-zero if any
- **Risk:** Medium — must not overwrite existing hooks
- **Test:** Enable → `git push` with errors → blocked. Disable → push works.

### Task 2.2: Toggle button in sidebar
- **Change `package.json`:** Add `codelab.togglePushGuard` command with lock icon
- **Change `extension.ts`:** Register command, toggle state, update button icon
- **Persist:** State in `.codelab/settings.json`
- **Test:** Toggle on/off, verify hook file appears/disappears

### Task 2.3: Status bar issue counter
- **Change `extension.ts`:** Add second status bar item showing "⚠ N issues"
- **Updates:** On conformance check, on real-time resolution
- **Test:** Visual — count goes down as issues are fixed

---

## Phase 3: Large Codebase Scaling (Sub-Agent Orchestration)

**Goal:** Handle 50+ file codebases by chunking and parallelizing.

### Task 3.1: Agent orchestrator
- **New file:** `src/agentOrchestrator.ts`
- **What:**
  - `chunkFiles(files, config)` → groups by directory, splits on size
  - `orchestratePatternExtraction(files, rootPath, progress)` — decides single vs chunked
  - Spawns parallel haiku agents with concurrency limit
  - Each writes to `.codelab/patterns/chunk-NNN.md`
- **Risk:** High — parallel process management, error handling for partial failures
- **Test:** Run on a 100+ file repo → verify chunks + final output

### Task 3.2: Pattern compiler
- **What:** Compiler prompt in `prompt.ts`, called by orchestrator after chunks complete
- **Model:** Sonnet reads all chunk files → produces unified `patterns.md`
- **Key:** Must deduplicate, resolve conflicts, maintain quality
- **Test:** Compile 5 chunk files → verify no duplication

### Task 3.3: Chunked conformance checking
- **What:** Same chunking for conformance, not just pattern extraction
- **Model:** Haiku agents check chunks in parallel → merge issue arrays
- **Test:** Run conformance on large repo → verify all files checked

---

## Phase 4: Deep Analysis Engine

**Goal:** Find deeper code quality issues beyond style conformance.

### Task 4.1: Deep analysis module
- **New file:** `src/deepAnalysis.ts`
- **What:**
  - Step 1: Opus plans the analysis (returns JSON strategy)
  - Step 2: 4x Sonnet agents run in parallel (redundancy, implementation, performance, security)
  - Step 3: Opus compiles findings → `summary.md`
  - Each agent writes to `.codelab/analysis/{category}.md`
- **Risk:** High — expensive (Opus calls), long-running, complex orchestration
- **Test:** Run on this extension's own codebase

### Task 4.2: Analysis TreeView
- **New file:** `src/analysisTreeProvider.ts`
- **Change `package.json`:** Add second view in sidebar
- **What:** Findings grouped by severity (critical → warning → info), clickable to file
- **Test:** Verify tree populates, items are clickable

### Task 4.3: Deep analysis prompts
- **Change `prompt.ts`:** Add orchestration, per-category, and compilation prompts
- **Category prompts must be focused:** Each agent gets only its category's instructions
- **Compilation prompt:** Opus merges, deduplicates, prioritizes by severity

### Task 4.4: Run button with icon
- **Change `package.json`:** Add `codelab.runDeepAnalysis` command with beaker icon
- **Change `extension.ts`:** Register command, wire to `deepAnalysis.ts`
- **UI:** Button in sidebar title bar, disabled during run

---

## Phase Order & Dependencies

```
Phase 1 ──────────────────► Phase 2 ──────────► Phase 3 ──────────► Phase 4
 1.1 Model selection         2.1 Git guard       3.1 Orchestrator    4.1 Deep analysis
 1.2 Persistence             2.2 Toggle button    3.2 Compiler        4.2 Analysis tree
 1.3 File watcher            2.3 Status counter   3.3 Chunked check   4.3 Prompts
                                                                      4.4 Run button

Dependencies:
  1.1 → 3.1 (model selection needed for haiku/opus agents)
  1.2 → 1.3 (persistence needed for watcher to persist)
  1.2 → 2.1 (persistence needed for git guard to read issues)
  3.1 → 4.1 (orchestration pattern reused for deep analysis)
```

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude CLI not installed | Extension is useless | Detect on activate, show install guide |
| Opus calls are expensive | User surprise bills | Show cost warning before deep analysis |
| Sub-agent partial failure | Incomplete results | Report which chunks failed, show partial |
| Pre-push hook conflicts | Breaks user's git workflow | Detect existing hooks, never overwrite |
| Large conformance.json | Slow load | Cap at 10K issues, paginate tree |
| Context window exceeded | Claude errors | Strict chunk sizing by char count |
| Rate limiting | Parallel agents hit limits | Configurable concurrency, retry with backoff |

---

## Implementation Notes

- **Always compile before committing.** `pnpm run compile` must pass.
- **One phase at a time.** Don't start Phase N+1 until Phase N compiles and works.
- **Each task is independently testable.** Don't batch — ship each task, verify, then continue.
- **Prompts are the most important code.** Spend time on prompt engineering — garbage prompts = garbage output.
- **The `.codelab/` directory should be `.gitignore`-able** but not by default. Teams may want to commit their patterns.
