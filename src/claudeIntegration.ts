import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface ClaudeResult {
	success: boolean;
	output: string;
	error?: string;
}

export function runClaudeAnalysis(
	systemPrompt: string,
	userMessage: string,
	workspacePath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ClaudeResult> {
	return new Promise((resolve) => {
		progress.report({ message: 'Starting Claude Code session...' });

		const args = [
			'--print',
			'--model', 'sonnet',
			'--system-prompt', systemPrompt,
		];

		const proc = spawn('claude', args, {
			cwd: workspacePath,
			env: { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Pipe the user message via stdin to avoid arg size limits and null byte issues
		proc.stdin.write(userMessage);
		proc.stdin.end();

		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;
			const lines = stdout.split('\n').length;
			progress.report({ message: `Analyzing patterns... (${lines} lines generated)` });
		});

		proc.stderr.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on('error', (err) => {
			resolve({
				success: false,
				output: '',
				error: `Failed to start Claude CLI: ${err.message}. Make sure 'claude' is installed and in your PATH.`,
			});
		});

		proc.on('close', (code) => {
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
