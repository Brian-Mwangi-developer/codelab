import * as fs from 'fs';
import * as path from 'path';

const SIGNATURE = '# Codelab Push Guard — auto-managed, do not edit manually';

const HOOK_SCRIPT = `#!/bin/sh
${SIGNATURE}
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
`;

function getHookPath(rootPath: string): string {
	return path.join(rootPath, '.git', 'hooks', 'pre-push');
}

function isOurHook(hookPath: string): boolean {
	if (!fs.existsSync(hookPath)) {
		return false;
	}
	const content = fs.readFileSync(hookPath, 'utf-8');
	return content.includes(SIGNATURE);
}

export function isPushGuardInstalled(rootPath: string): boolean {
	return isOurHook(getHookPath(rootPath));
}


export function installPushGuard(rootPath: string): string | null {
	const hookPath = getHookPath(rootPath);
	const hooksDir = path.dirname(hookPath);

	// Ensure hooks directory exists
	if (!fs.existsSync(hooksDir)) {
		fs.mkdirSync(hooksDir, { recursive: true });
	}

	// Check for existing non-Codelab hook
	if (fs.existsSync(hookPath) && !isOurHook(hookPath)) {
		return 'A pre-push hook already exists and was not created by Codelab. Please remove it manually or merge the hooks.';
	}

	fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
	return null;
}


export function removePushGuard(rootPath: string): void {
	const hookPath = getHookPath(rootPath);
	if (isOurHook(hookPath)) {
		fs.unlinkSync(hookPath);
	}
}
