# Codelab PR Review Integration — Design Document

## Overview

When a Pull Request is opened (or updated) on GitHub, Codelab automatically reviews the changed files against the repo's extracted patterns (`.codelab/patterns.md`) and posts inline review comments on lines that violate conventions.

This turns Codelab from a local-only tool into a team-wide code quality gate — every PR gets reviewed against the same patterns, whether the author has the VS Code extension installed or not.

---

## How It Works

```
Developer opens PR
        │
        ▼
GitHub Actions triggers workflow
        │
        ▼
Uses official `anthropics/claude-code-action@v1`
        │
        ▼
Claude Code reads .codelab/patterns.md + git diff
        │
        ▼
Reviews changes against patterns
        │
        ▼
Posts inline PR review comments via GitHub API
        │
        ▼
Optionally blocks merge if errors found (via check status)
```

---

## Authentication — Why We Can't Use Subscription Auth in CI

### The Problem

Claude Code stores subscription auth via OAuth tokens in:
- **macOS:** Encrypted in macOS Keychain
- **Linux:** `~/.claude/.credentials.json` (mode `0600`)

These tokens are **tied to interactive browser login** and cannot be exported, serialized, or transferred to a CI environment. There is no `claude export-token` command.

### The Solution: Claude Console API Key

Anthropic separates subscription auth (for interactive use) from API keys (for programmatic/CI use):

| Auth Method | Where | Cost Model |
|-------------|-------|------------|
| Subscription OAuth | Local CLI, interactive | Monthly plan (Pro/Max) |
| Console API Key | CI/CD, programmatic | Pay-per-token |
| AWS Bedrock | Enterprise CI | Cloud billing |
| Google Vertex AI | Enterprise CI | Cloud billing |

**For Codelab PR Review, users need a Console API key** from [console.anthropic.com](https://console.anthropic.com).

### Why This Is Still Cheap

- We use **Haiku** model (not Sonnet/Opus) — the cheapest option
- We only review the **diff** (not the whole repo)
- Typical PR (10 files, ~500 changed lines) ≈ 5K-15K input tokens
- **Cost per review: ~$0.002-0.01** (fractions of a cent)
- A team doing 50 PRs/week would pay **~$0.50/week**
- Anthropic Console gives **$5 free credit** on signup

We make this transparent in the setup flow — show estimated cost before generating the workflow.

### Alternative: Self-Hosted Runner (Free, Uses Subscription)

For users who truly want $0 extra cost:
- Run a self-hosted GitHub Actions runner on a machine where Claude Code is authenticated
- The workflow uses the local CLI auth (subscription)
- Tradeoff: requires maintaining a runner

We support both paths — the workflow detects whether `ANTHROPIC_API_KEY` is set and falls back to local auth.

---

## Key Design Decisions

### 1. Build on `anthropics/claude-code-action@v1`

**Why:** Anthropic already maintains an official GitHub Action for Claude Code. It handles:
- CLI installation
- Authentication
- Process management
- GitHub API integration

We don't rebuild this. Instead, we **configure it with our patterns-aware prompt** via the `prompt` parameter (automation mode).

### 2. Only review changed lines (not the whole repo)

**Why:** Reviewing the entire repo on every PR is expensive, slow, and noisy. Developers only care about issues in code *they touched*.

**How:** The action gets the diff context automatically. Our prompt instructs Claude to only flag issues on changed lines.

### 3. Use the committed `.codelab/patterns.md`

**Why:** The patterns file is the source of truth. By committing it to the repo, the whole team shares the same standards. The PR review uses the *same* patterns the local extension uses.

**Requirement:** Teams must commit `.codelab/patterns.md` to the repo (not `.gitignore` it).

### 4. Post as a PR Review (not individual comments)

**Why:** A single review with inline comments is cleaner than N separate comment notifications. GitHub's review API supports "REQUEST_CHANGES" or "COMMENT" events, integrating with branch protection rules.

### 5. Two workflow modes

**Tag mode (interactive):** Developers can `@claude` in PR comments to ask about pattern conformance.

**Automation mode (automatic):** Every PR gets reviewed automatically on open/push.

We generate **both** — automation mode runs on every PR, tag mode lets developers ask follow-up questions.

---

## Architecture

### Approach A: Official Action (Recommended)

Leverages `anthropics/claude-code-action@v1` in automation mode with a custom prompt that includes the patterns.

```
┌──────────────────────────────────────────────────┐
│  .github/workflows/codelab-review.yml            │
│                                                   │
│  Trigger: pull_request [opened, synchronize]      │
│                                                   │
│  Steps:                                           │
│  1. Checkout (fetch-depth: 0)                     │
│  2. Check .codelab/patterns.md exists             │
│  3. Read patterns + build prompt                  │
│  4. Run claude-code-action with prompt            │
│     → Claude reads diff, reviews against patterns │
│     → Action posts review comments automatically  │
└──────────────────────────────────────────────────┘
```

**Pros:** Minimal code, maintained by Anthropic, handles edge cases.
**Cons:** Less control over comment formatting.

### Approach B: Custom Review Script (Power Users)

For teams that want full control, we also generate a standalone `.codelab/review.js` script.

```
┌──────────────────────────────────────────────────┐
│  .github/workflows/codelab-review.yml            │
│                                                   │
│  Steps:                                           │
│  1. Checkout (fetch-depth: 0)                     │
│  2. Install Claude Code CLI                       │
│  3. Read patterns + git diff                      │
│  4. Pipe to Claude CLI → JSON output              │
│  5. Map issues to diff positions                  │
│  6. Post PR review via GitHub API                 │
└──────────────────────────────────────────────────┘
```

**Pros:** Full control, customizable, works without the official action.
**Cons:** More code to maintain, diff position mapping is complex.

**Default:** Approach A. Offer Approach B as an advanced option.

---

## GitHub Actions Workflow (Approach A)

```yaml
# .github/workflows/codelab-review.yml
name: Codelab PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]          # For @claude tag mode
  pull_request_review_comment:
    types: [created]          # For @claude in review threads

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    # Only run if patterns exist (checked in the prompt step)
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check for patterns
        id: patterns
        run: |
          if [ ! -f ".codelab/patterns.md" ]; then
            echo "skip=true" >> $GITHUB_OUTPUT
            echo "::notice::No .codelab/patterns.md found. Run 'Codelab: Extract Patterns' locally first."
          else
            echo "skip=false" >> $GITHUB_OUTPUT
            # Read patterns into env var for the prompt
            PATTERNS=$(cat .codelab/patterns.md)
            echo "CODELAB_PATTERNS<<PATTERNS_EOF" >> $GITHUB_ENV
            echo "$PATTERNS" >> $GITHUB_ENV
            echo "PATTERNS_EOF" >> $GITHUB_ENV
          fi

      - name: Codelab Review
        if: steps.patterns.outputs.skip != 'true'
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: haiku
          prompt: |
            You are Codelab, a code pattern conformance reviewer.

            This repository has established engineering patterns documented below.
            Review ONLY the changed files in this PR against these patterns.

            Rules:
            1. ONLY flag issues that violate the patterns document.
            2. ONLY comment on CHANGED lines — never flag unchanged code.
            3. Be specific: quote the violating code and suggest the fix.
            4. If everything follows the patterns, approve with a brief note.
            5. Group related issues into a single comment where possible.
            6. Use severity labels: 🔴 ERROR (must fix) or 🟡 WARNING (should fix).

            ## Project Patterns

            ${{ env.CODELAB_PATTERNS }}

          # Tag mode: also responds to @claude mentions
          trigger_phrase: "@claude"
          timeout_minutes: 5
```

---

## The Review Prompt (For Approach B — Custom Script)

```
SYSTEM:
You are Codelab, a strict code reviewer. Review pull request diffs against
the project's established engineering patterns.

Rules:
1. ONLY flag issues that violate the patterns document below.
2. ONLY flag issues on CHANGED lines (lines starting with + in the diff).
3. For each issue, return: file path, line number, severity (error/warning),
   the violated rule, and a specific fix suggestion.
4. If the changes follow all patterns, return an empty array.
5. Be concise. One sentence per issue.
6. Return ONLY a JSON array. No markdown, no explanation.

Output format:
[
  {
    "file": "src/utils/auth.ts",
    "line": 42,
    "severity": "error",
    "rule": "Error Handling: Always use custom AppError class",
    "message": "Using generic `throw new Error()` instead of `AppError`",
    "suggestion": "Replace with `throw new AppError('message', ErrorCode.AUTH_FAILED)`"
  }
]

USER:
## Patterns
<contents of .codelab/patterns.md>

## Changed Files
<list of changed files>

## Diff
<full unified diff>

## File Contents (changed files only)
<full content of each changed file for context>
```

---

## Diff Position Mapping (Approach B Only)

GitHub's PR review comment API requires a `position` field relative to the diff hunk, not the file line number.

### Algorithm:

```
For each issue from Claude:
  1. Find the file's diff hunk in the unified diff
  2. Walk through the diff lines, counting positions (starting at 1)
  3. For each line starting with "+" or " " (added or context):
     - Track the "new file" line number
     - If it matches the issue's line number → that's the position
  4. If the line isn't in the diff → post as file-level comment instead
```

**Strategy:**
- Lines in the diff → inline comments with `position`
- Lines not in the diff but in changed files → file-level comment (`subject_type: "file"`)

*Note: Approach A handles this automatically — the official action manages comment placement.*

---

## Implementation Plan

### Phase 1: "Setup PR Review" Command

Add a new VS Code command `Codelab: Setup PR Review` that:

1. Checks `.codelab/patterns.md` exists (error if not)
2. Asks user which approach: "Quick Setup (recommended)" vs "Custom Script (advanced)"
3. Creates `.github/workflows/codelab-review.yml`
4. For custom script: also creates `.codelab/review.js`
5. Shows setup instructions:
   - "Commit these files to your repo"
   - "Add ANTHROPIC_API_KEY as a GitHub Secret"
   - Link to console.anthropic.com
   - Estimated cost: "~$0.002-0.01 per PR review"

**Files to create/modify:**
- `src/prReviewSetup.ts` — new module with the setup logic + workflow templates
- `src/extension.ts` — register the new command
- `package.json` — add `codelab.setupPRReview` command

### Phase 2: Custom Review Script (Approach B)

If user chose the custom script approach:
- Generate `.codelab/review.js` — standalone Node.js script
- Reads patterns, gets diff, calls Claude CLI, parses JSON, posts via GitHub API
- Includes diff position mapping logic
- No npm dependencies (uses Node.js built-ins + `claude` CLI + `gh` CLI)

### Phase 3: Refinements
- Configurable severity threshold (only block on errors, allow warnings)
- Configurable base branch (not just `main`)
- Support for monorepos (only check patterns relevant to changed paths)
- Caching — skip review if no code files changed
- Dismiss stale reviews when new commits are pushed
- Cost estimation in review comment footer

---

## User Flow

```
1. User has Codelab installed, patterns extracted and COMMITTED to repo

2. User runs "Codelab: Setup PR Review" from command palette
   → Prompt: "Quick Setup (uses official action) or Custom Script?"
   → Generates workflow file (and optionally review script)
   → Shows: "Add ANTHROPIC_API_KEY as GitHub Secret. Est. cost: ~$0.01/review"

3. User commits workflow files and adds API key as GitHub Secret
   (Go to: GitHub repo → Settings → Secrets → Actions → New)
   (Get key from: console.anthropic.com → API Keys)

4. Developer opens a PR
   → GitHub Actions triggers workflow
   → Claude reads patterns + diff
   → Posts inline review: "🔴 ERROR: Using snake_case, project uses camelCase"
   → If errors: status check fails (blocks merge if branch protection enabled)
   → If clean: "✅ Codelab: All patterns followed"

5. Developer can also @claude in PR comments
   → "Is this import order correct per our patterns?"
   → Claude responds with pattern-aware answer

6. Developer fixes issues, pushes
   → Workflow re-runs, new review posted
```

---

## Cost Breakdown

| Scenario | Model | Input Tokens | Output Tokens | Cost |
|----------|-------|-------------|---------------|------|
| Small PR (3 files, 50 lines) | Haiku | ~3K | ~500 | ~$0.002 |
| Medium PR (10 files, 500 lines) | Haiku | ~15K | ~1K | ~$0.005 |
| Large PR (30 files, 2000 lines) | Haiku | ~50K | ~2K | ~$0.02 |
| Huge PR (50+ files) | Haiku | ~100K+ | ~3K | ~$0.04 |

**Bottom line:** Even at 50 PRs/week, a team pays less than $1/week.

Free tier on console.anthropic.com includes $5 credit — enough for ~1000+ reviews.

---

## Security

- `ANTHROPIC_API_KEY` stored as GitHub Secret (never exposed in logs)
- `GITHUB_TOKEN` is auto-provided by Actions with scoped permissions (`pull-requests: write`)
- Only repo files are read — no external network calls besides Claude API and GitHub API
- Diff content is sent to Claude API (same privacy model as any Claude Code usage)
- Patterns file is already committed to the repo (no secrets in it)

---

## Open Questions

1. **Should we support the self-hosted runner path in the generated workflow?**
   → Could add a conditional: if `ANTHROPIC_API_KEY` is set, use it; otherwise, assume local auth.
   → Decision: Yes, document it as an alternative but don't generate a separate workflow.

2. **Should we support GitLab/Bitbucket?**
   → GitHub-only for v1. GitLab CI support could be Phase 4.

3. **How to handle repos without committed patterns?**
   → Workflow skips gracefully with a notice. Could offer "Extract in CI" but that's expensive.

4. **Should we dismiss stale reviews when new commits are pushed?**
   → Yes — prevents confusion. Use GitHub's dismiss review API.

5. **Model selection — Haiku vs Sonnet?**
   → Default to Haiku for cost. Offer a workflow variable to upgrade to Sonnet for higher accuracy.

---

## Success Metrics

- PR review comments are accurate (>80% of flagged issues are real violations)
- Review completes in under 30 seconds for typical PRs
- Zero false merge blocks (no errors on code that follows patterns)
- Setup takes under 2 minutes (one command + one GitHub Secret)
- Teams keep it enabled after trying it (retention > 70%)
