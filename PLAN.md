# Codelab — VS Code Extension Architecture Plan

## Vision

Codelab is a VS Code extension that **analyzes a codebase and extracts engineering patterns** — naming conventions, error handling styles, import syntax, file structure, component patterns — and enforces them. It saves patterns to `.codelab/patterns.md` and generates agent-specific config files (`CLAUDE.md`, `.cursorrules`). It then checks code conformance against those patterns and surfaces issues inline via diagnostics, hovers, lightbulb fixes, and a dedicated sidebar panel.

The goal: emulate a senior engineer reviewing code so junior developers and AI tools produce code that matches team standards.

## Workflows

### 1. Extract Patterns
```
User clicks "Extract Patterns" (status bar or command palette)
        │
        ▼
Extension collects workspace files (respects .gitignore + ignore list)
        │
        ▼
Spawns `claude --print` with pattern extraction prompt + file contents via stdin
        │
        ▼
Saves output → .codelab/patterns.md
        │
        ▼
Second Claude call generates CLAUDE.md + .cursorrules from patterns
        │
        ▼
Opens patterns.md, notifies user
```

### 2. Check Conformance
```
User clicks Codelab icon in activity bar → sidebar opens
        │
        ▼
User clicks "Check Conformance" (sidebar title or command palette)
        │
        ▼
Extension reads .codelab/patterns.md + collects workspace files
        │
        ▼
Spawns `claude --print` with conformance prompt → returns JSON issues
        │
        ▼
Issues populate:
  ├── Sidebar TreeView (grouped by file, clickable → opens file at line)
  ├── DiagnosticCollection (inline squiggly lines in editor)
  ├── HoverProvider (hover on issue line → shows rule + suggestion)
  └── CodeActionProvider (lightbulb → quick fix suggestion)
```

## Architecture

```
src/
├── extension.ts              # Entry point — registers all commands, views, providers
├── fileCollector.ts           # Walks workspace, respects ignores, reads file contents
├── claudeIntegration.ts       # Spawns Claude CLI subprocess via stdin, manages I/O
├── prompt.ts                  # All prompt templates (patterns, agent files, conformance)
├── conformanceChecker.ts      # Orchestrates conformance check, parses JSON issues
├── issuesTreeProvider.ts      # TreeDataProvider for sidebar issues panel
├── diagnosticsProvider.ts     # DiagnosticCollection for inline squiggles
├── hoverProvider.ts           # Shows pattern violation details on hover
└── codeActionProvider.ts      # Lightbulb quick-fix suggestions
```

### Module Responsibilities

#### `fileCollector.ts`
- Walks workspace recursively, respects IGNORED_DIRS + IGNORED_FILES + .gitignore
- Skips binary files (by extension) and files with null bytes
- Caps file size at 100KB
- `collectFiles(rootPath)` → `{ relativePath, content }[]`
- `countFiles(rootPath)` → `number`

#### `claudeIntegration.ts`
- `runClaudeAnalysis(systemPrompt, userMessage, workspacePath, progress)` → `ClaudeResult`
- Spawns: `claude --print --model sonnet --system-prompt <prompt>`
- Pipes user message via **stdin** (avoids arg size limits / null byte issues)
- Streams progress updates as data arrives

#### `prompt.ts`
- `getSystemPrompt()` — Pattern extraction instructions (10 categories)
- `getAgentFilePrompt()` — Generates CLAUDE.md + .cursorrules from patterns
- `getConformancePrompt()` — Strict code reviewer returning JSON issues
- `buildUserMessage(files)` / `buildAgentFileMessage()` / `buildConformanceMessage()`

#### `conformanceChecker.ts`
- `checkConformance(rootPath, progress)` → `ConformanceIssue[]`
- Reads patterns.md, collects files, runs Claude, parses JSON

#### `issuesTreeProvider.ts`
- Groups issues by file in a tree view
- Each issue is clickable → opens file at exact line
- Tooltip shows rule + suggestion in markdown

#### `diagnosticsProvider.ts`
- Creates VS Code diagnostics (warning/error squiggles) per issue
- Source labeled "Codelab", code shows the violated rule

#### `hoverProvider.ts`
- On hover over an issue line → shows severity, rule, suggestion, link to patterns.md

#### `codeActionProvider.ts`
- Lightbulb appears on issue lines → shows fix suggestion as a QuickFix action

## Output Files

| File | Purpose |
|------|---------|
| `.codelab/patterns.md` | Full pattern analysis with examples |
| `.codelab/CLAUDE.md` | Imperative rules for Claude Code / Claude agents |
| `.codelab/.cursorrules` | Flat rule list for Cursor AI |

## Key Design Decisions

1. **Claude CLI via `--print` + stdin** — Non-interactive, pipes large payloads safely
2. **Sonnet model** — Fast and cost-effective for both extraction and conformance
3. **Activity bar icon** — Grayscale SVG, theme-friendly, opens dedicated sidebar
4. **JSON output for conformance** — Structured, parseable, maps directly to VS Code APIs
5. **All providers share issue state** — Single conformance run updates tree, diagnostics, hovers, and code actions

## Future Phases

- Watch mode: auto-check on file save
- Git-aware: only check changed files (git diff)
- Per-directory pattern overrides
- Pattern diff: show what changed between extractions
- Team pattern merging across repos
- Auto-fix: apply suggestions directly via workspace edits
