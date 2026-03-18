# Codelab — System Design

Detailed technical design for each feature. Reference ARCHITECTURE.md for the big picture.

---

## Feature 1: Real-time Conformance Updates

### Problem
When a user fixes an issue, they currently have to re-run the full conformance check to see it disappear. This is slow and breaks flow.

### Design

**Trigger:** `vscode.workspace.onDidSaveTextDocument`

**Algorithm (lightweight, no Claude call):**
```
on file save(document):
  relativePath = workspace.asRelativePath(document.uri)
  fileIssues = currentIssues.filter(i => i.file === relativePath)

  if fileIssues.length === 0: return  // no issues for this file

  survivingIssues = []
  for each issue in fileIssues:
    lineIndex = issue.line - 1
    if lineIndex >= document.lineCount:
      continue  // line was deleted → issue resolved

    currentLineText = document.lineAt(lineIndex).text
    // Simple heuristic: if the line content changed, the issue is likely resolved
    // We store original line text in conformance.json for comparison
    if currentLineText !== issue.originalLineText:
      continue  // line changed → issue resolved

    survivingIssues.push(issue)

  replace issues for this file with survivingIssues
  update all providers
  persist to conformance.json
```

**Key detail:** We add `originalLineText` to the `ConformanceIssue` interface so we can detect changes without calling Claude.

**Edge case — new issues introduced by fix:**
We do NOT detect new issues on save. That requires a full Claude check. The user can click Refresh for that. This is intentional — saves cost and avoids false positives.

### Changes Required
- `conformanceChecker.ts`: Add `originalLineText` to `ConformanceIssue`
- New file: `fileWatcher.ts`
- `extension.ts`: Register file watcher in `activate()`
- `persistenceManager.ts`: Include `originalLineText` in serialization

---

## Feature 2: Large Codebase Scaling (Sub-Agent Orchestration)

### Problem
Passing 200+ files to a single Claude call exceeds context limits and is slow.

### Design

**Chunking strategy:**
```typescript
interface ChunkConfig {
  maxFilesPerChunk: number;  // default: 30
  maxCharsPerChunk: number;  // default: 150_000 (~37K tokens)
  maxParallelAgents: number; // default: 5
}
```

Files are grouped by directory first (keeps related files together), then split if a group exceeds the limit.

**Execution flow:**
```
                    ┌─────────────────┐
                    │ agentOrchestrator│
                    │ .orchestrate()  │
                    └────────┬────────┘
                             │
              files.length <= threshold?
              ┌──── yes ─────┴───── no ────┐
              │                            │
     ┌────────┴────────┐      ┌───────────┴───────────┐
     │ Single session  │      │ chunkFiles()           │
     │ (sonnet)        │      │ → spawn N haiku agents │
     │ → patterns.md   │      │ → each writes          │
     └─────────────────┘      │   patterns/chunk-N.md  │
                              └───────────┬────────────┘
                                          │
                              ┌───────────┴────────────┐
                              │ Compiler session        │
                              │ (sonnet)                │
                              │ reads all chunks        │
                              │ → writes patterns.md    │
                              └─────────────────────────┘
```

**Sub-agent spawning (parallel with concurrency limit):**
```typescript
async function runChunkedAnalysis(
  chunks: CollectedFile[][],
  config: ChunkConfig
): Promise<string[]> {
  const results: string[] = [];
  // Process in batches of maxParallelAgents
  for (let i = 0; i < chunks.length; i += config.maxParallelAgents) {
    const batch = chunks.slice(i, i + config.maxParallelAgents);
    const promises = batch.map((chunk, idx) =>
      runClaudeAnalysis(
        getChunkPatternPrompt(),
        buildChunkMessage(chunk),
        workspacePath,
        progress,
        'haiku'  // model override
      )
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.map(r => r.output));
  }
  return results;
}
```

**Compiler prompt:** Takes N chunk outputs, deduplicates, resolves conflicts, produces unified patterns.md.

**File storage:**
```
.codelab/patterns/
  chunk-001.md   # "Files: src/auth/*.ts — Findings: ..."
  chunk-002.md   # "Files: src/api/*.ts — Findings: ..."
  ...
```
These are NOT deleted after compilation. They serve as audit trail and can be re-compiled without re-analyzing.

### Changes Required
- `claudeIntegration.ts`: Add `model` parameter to `runClaudeAnalysis()`
- New file: `agentOrchestrator.ts`
- `prompt.ts`: Add chunk-specific and compiler prompts
- `extension.ts`: Use orchestrator instead of direct Claude call

---

## Feature 3: Persistence

### Problem
Reloading the VS Code window loses all conformance issues. User has to re-run the check.

### Design

**Storage location:** `.codelab/conformance.json`

**Schema:**
```typescript
interface PersistedConformance {
  version: 2;
  timestamp: string;           // ISO 8601
  patternsHash: string;        // SHA-256 of patterns.md content
  issues: PersistedIssue[];
}

interface PersistedIssue extends ConformanceIssue {
  originalLineText: string;    // for real-time invalidation
  fileHash: string;            // SHA-256 of file content at check time
}
```

**Load on activation:**
```
activate():
  cached = readConformanceCache()
  if !cached: show empty tree, return

  // Validate patterns haven't changed
  currentPatternsHash = hash(read('.codelab/patterns.md'))
  if currentPatternsHash !== cached.patternsHash:
    discard all → show "Patterns changed, re-run conformance check"
    return

  // Validate per-file
  validIssues = []
  for each issue in cached.issues:
    currentFileHash = hash(read(issue.file))
    if currentFileHash === issue.fileHash:
      validIssues.push(issue)  // file unchanged, issues still valid
    // else: file changed, discard its issues

  setIssues(validIssues)
```

**Save triggers:**
- After conformance check completes
- After real-time watcher removes issues
- Debounced (100ms) to avoid excessive writes

### Changes Required
- New file: `persistenceManager.ts`
- `conformanceChecker.ts`: Hash computation, store originalLineText
- `extension.ts`: Load on activate, save after updates

---

## Feature 4: Git Push Guard

### Problem
Even with conformance issues visible, a developer can still `git push` sloppy code.

### Design

**Mechanism:** Git pre-push hook

**Hook script (`.git/hooks/pre-push`):**
```bash
#!/bin/sh
# Codelab Push Guard — auto-managed, do not edit manually
CONFORMANCE_FILE=".codelab/conformance.json"

if [ ! -f "$CONFORMANCE_FILE" ]; then
  exit 0  # No conformance data, allow push
fi

# Count errors (not warnings — warnings don't block)
ERROR_COUNT=$(node -e "
  const data = JSON.parse(require('fs').readFileSync('$CONFORMANCE_FILE', 'utf-8'));
  const errors = data.issues.filter(i => i.severity === 'error');
  console.log(errors.length);
")

if [ "$ERROR_COUNT" -gt 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  Codelab: $ERROR_COUNT conformance error(s) found.  ║"
  echo "║  Please resolve errors before pushing.              ║"
  echo "║                                                      ║"
  echo "║  Run 'Codelab: Check Conformance' in VS Code        ║"
  echo "║  to see details.                                     ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

exit 0
```

**Toggle mechanism:**
- Button in sidebar title: lock icon (🔒 enabled / 🔓 disabled)
- State saved in `.codelab/settings.json` → `pushGuardEnabled: true/false`
- When enabled: write hook file, `chmod +x`
- When disabled: remove hook file (or replace with no-op)
- If a pre-push hook already exists (not ours): WARN user, don't overwrite
  - Detect by checking for our signature comment at the top

**Important safety:**
- Only block on `severity: "error"`, not warnings
- The hook reads the persisted JSON — no Claude call needed at push time
- If conformance.json doesn't exist, allow push (don't block on first use)

### Changes Required
- New file: `gitGuard.ts`
- `package.json`: New command `codelab.togglePushGuard` + menu entry
- `.codelab/settings.json`: Push guard state
- `extension.ts`: Register toggle command, show current state in button

---

## Feature 5: Deep Analysis Engine

### Problem
Conformance checks verify style. But codebases also suffer from deeper issues: redundancy, wrong implementations, performance overhead, security holes. These require a more expensive, thoughtful analysis.

### Design

**This is a SEPARATE process from conformance.** Different button, different panel, different data.

**Analysis categories:**

| Category | What it finds | Agent model |
|----------|---------------|-------------|
| Redundancy | Duplicate logic, copy-paste code, overlapping functions | sonnet |
| Implementation | Race conditions, incorrect async, deadlocks, wrong patterns | sonnet |
| Performance | N+1 queries, blocking main thread, unnecessary computation, large imports | sonnet |
| Security | Injection risks, hardcoded secrets, insecure defaults | sonnet |

**Orchestration model:** Opus (plans the analysis, dispatches sub-agents, compiles results)

**Flow:**
```
User clicks "Run Deep Analysis" button
        │
        ▼
Opus orchestrator receives: file list + patterns.md for context
        │
        ▼
Opus decides analysis strategy, spawns 4 Sonnet sub-agents in parallel:
  ├── Redundancy agent  → .codelab/analysis/redundancy.md
  ├── Implementation agent → .codelab/analysis/implementation.md
  ├── Performance agent → .codelab/analysis/performance.md
  └── Security agent    → .codelab/analysis/security.md
        │
        ▼ (all complete)
Opus reads all 4 outputs, compiles → .codelab/analysis/summary.md
        │
        ▼
Extension parses summary.md → populates Deep Analysis TreeView
```

**How Opus orchestration works with CLI:**

We can't have Opus literally spawn sub-agents through the CLI. Instead:

```
Step 1: Spawn `claude --print --model opus` with orchestration prompt
  → Returns a structured plan (JSON) of what each agent should analyze

Step 2: Extension spawns 4x `claude --print --model sonnet` with per-category prompts
  → Each writes to .codelab/analysis/{category}.md

Step 3: Spawn `claude --print --model opus` with compilation prompt
  → Reads all category files → produces summary.md with structured findings
```

This gives us Opus-level thinking for planning and compilation, with Sonnet doing the bulk analysis work cost-effectively.

**Deep Analysis issue format:**
```typescript
interface AnalysisFinding {
  category: 'redundancy' | 'implementation' | 'performance' | 'security';
  severity: 'info' | 'warning' | 'critical';
  title: string;           // e.g., "Duplicate validation logic"
  description: string;     // detailed explanation
  files: string[];         // affected files
  lines?: { file: string; start: number; end: number }[];
  impact: string;          // why this matters
  recommendation: string;  // what to do about it
}
```

**TreeView structure:**
```
Deep Analysis
  ├── 🔴 Critical (2)
  │   ├── Race condition in auth middleware — src/auth.ts:45
  │   └── SQL injection in search endpoint — src/api/search.ts:12
  ├── 🟡 Warnings (5)
  │   ├── Duplicate validation in form handlers — 3 files
  │   └── ...
  └── 🔵 Info (3)
      ├── Consider memoizing expensive computation — src/utils.ts:78
      └── ...
```

### Changes Required
- New file: `deepAnalysis.ts`
- New file: `analysisTreeProvider.ts`
- `prompt.ts`: Orchestration, per-category, and compilation prompts
- `package.json`: New view, commands, menu entries
- `claudeIntegration.ts`: Support for model selection (opus/sonnet/haiku)
- `extension.ts`: Wire deep analysis command + tree view

---

## Feature 6: Model Selection in Claude Integration

### Current
Hardcoded to `sonnet`.

### New Design
```typescript
type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

function runClaudeAnalysis(
  systemPrompt: string,
  userMessage: string,
  workspacePath: string,
  progress: Progress,
  model: ClaudeModel = 'sonnet'
): Promise<ClaudeResult>
```

The `model` parameter maps to `--model haiku`, `--model sonnet`, or `--model opus` in the CLI args.

---

## Cross-Cutting Concerns

### Error Handling Strategy
- **Claude CLI not found:** Show install instructions, link to docs
- **Claude CLI errors (API/rate limit):** Show error message, suggest retry
- **Timeout (>5min per agent):** Kill process, report partial results
- **Invalid JSON from conformance:** Attempt repair (strip markdown fences), then show raw output option
- **Partial sub-agent failure:** Complete what we can, report which chunks failed

### Cost Awareness
- Haiku for bulk analysis (cheap, fast)
- Sonnet for pattern extraction and conformance (balanced)
- Opus only for orchestration planning and compilation (expensive, used sparingly)
- Show estimated token usage in progress notifications where possible

### Concurrency Safety
- Only one conformance check at a time (disable button during run)
- Only one deep analysis at a time
- File watcher updates are debounced (300ms)
- Persistence writes are debounced (100ms) and serialized

### Extension Lifecycle
```
activate():
  1. Load persisted conformance issues (validate hashes)
  2. Load settings (push guard state, etc.)
  3. Register all commands, views, providers
  4. Start file watcher
  5. Update status bar with issue count

deactivate():
  1. Persist any pending state
  2. Dispose all subscriptions
```
