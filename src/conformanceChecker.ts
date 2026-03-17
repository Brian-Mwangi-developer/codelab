import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles, CollectedFile } from './fileCollector';
import { runClaudeAnalysis } from './claudeIntegration';
import { getConformancePrompt, buildConformanceMessage } from './prompt';

export interface ConformanceIssue {
	file: string;
	line: number;
	column: number;
	severity: 'warning' | 'error';
	message: string;
	rule: string;
	suggestion: string;
}

export async function checkConformance(
	rootPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ConformanceIssue[]> {
	// Read patterns file
	const patternsPath = path.join(rootPath, '.codelab', 'patterns.md');
	if (!fs.existsSync(patternsPath)) {
		vscode.window.showWarningMessage(
			'No patterns found. Run "Codelab: Extract Patterns" first.'
		);
		return [];
	}

	const patternsContent = fs.readFileSync(patternsPath, 'utf-8');

	// Collect files to check — look for recently changed files via git
	progress.report({ message: 'Finding files to check...' });
	let filesToCheck: CollectedFile[];

	try {
		filesToCheck = collectFiles(rootPath);
	} catch {
		return [];
	}

	if (filesToCheck.length === 0) {
		vscode.window.showInformationMessage('No files to check.');
		return [];
	}

	progress.report({ message: `Checking ${filesToCheck.length} files against patterns...` });

	const systemPrompt = getConformancePrompt();
	const userMessage = buildConformanceMessage(patternsContent, filesToCheck);

	const result = await runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress);

	if (!result.success) {
		vscode.window.showErrorMessage(`Conformance check failed: ${result.error}`);
		return [];
	}

	// Parse JSON output
	try {
		const cleaned = result.output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
		const issues: ConformanceIssue[] = JSON.parse(cleaned);
		return issues.filter(
			(i) => i.file && typeof i.line === 'number' && i.message
		);
	} catch (e) {
		vscode.window.showErrorMessage('Failed to parse conformance results. Claude may have returned invalid JSON.');
		return [];
	}
}
