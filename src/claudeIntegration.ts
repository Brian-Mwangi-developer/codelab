import * as vscode from 'vscode';
import { spawn, ChildProcess, execSync } from 'child_process';

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

export interface ClaudeResult {
	success: boolean;
	output: string;
	error?: string;
}

/**
 * Checks if Claude Code CLI is installed and accessible.
 */
export function isClaudeInstalled(): boolean {
	try {
		execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Shows a warning with install instructions if Claude CLI is missing.
 * Returns true if Claude is available, false otherwise.
 */
export async function ensureClaudeAvailable(): Promise<boolean> {
	if (isClaudeInstalled()) {
		return true;
	}

	const action = await vscode.window.showErrorMessage(
		'Codelab requires Claude Code CLI to function. Please install it first.',
		'Install Guide',
		'Dismiss'
	);

	if (action === 'Install Guide') {
		vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/overview'));
	}

	return false;
}

export function runClaudeAnalysis(
	systemPrompt: string,
	userMessage: string,
	workspacePath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	model: ClaudeModel = 'sonnet',
	token?: vscode.CancellationToken
): Promise<ClaudeResult> {
	return new Promise((resolve) => {
		progress.report({ message: `Starting Claude Code session (${model})...` });

		const args = [
			'--print',
			'--model', model,
			'--system-prompt', systemPrompt,
		];

		const proc: ChildProcess = spawn('claude', args, {
			cwd: workspacePath,
			env: { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Handle cancellation — kill the process
		let cancelled = false;
		const cancelDisposable = token?.onCancellationRequested(() => {
			cancelled = true;
			proc.kill('SIGTERM');
		});

		// Pipe the user message via stdin to avoid arg size limits and null byte issues
		proc.stdin!.write(userMessage);
		proc.stdin!.end();

		let stdout = '';
		let stderr = '';

		proc.stdout!.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;
			const lines = stdout.split('\n').length;
			progress.report({ message: `Analyzing (${model})... ${lines} lines generated` });
		});

		proc.stderr!.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on('error', (err) => {
			cancelDisposable?.dispose();
			resolve({
				success: false,
				output: '',
				error: `Failed to start Claude CLI: ${err.message}. Make sure 'claude' is installed and in your PATH.`,
			});
		});

		proc.on('close', (code) => {
			cancelDisposable?.dispose();

			if (cancelled) {
				resolve({
					success: false,
					output: '',
					error: 'Operation cancelled by user.',
				});
				return;
			}

			if (code === 0 && stdout.trim()) {
				resolve({ success: true, output: stdout.trim() });
			} else {
				resolve({
					success: false,
					output: stdout,
					error: stderr || `Claude CLI exited with code ${code}`,
				});
			}
		});
	});
}
