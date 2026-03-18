import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles, CollectedFile } from './fileCollector';
import { runClaudeAnalysis } from './claudeIntegration';
import { getConformancePrompt, buildConformanceMessage } from './prompt';
import { PersistedIssue, sha256 } from './persistenceManager';

export interface ConformanceIssue {
	file: string;
	line: number;
	column: number;
	severity: 'warning' | 'error';
	message: string;
	rule: string;
	suggestion: string;
}

export interface ConformanceResult {
	issues: PersistedIssue[];
	patternsHash: string;
}

export async function checkConformance(
	rootPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ConformanceResult | null> {
	// Read patterns file
	const patternsPath = path.join(rootPath, '.codelab', 'patterns.md');
	if (!fs.existsSync(patternsPath)) {
		vscode.window.showWarningMessage(
			'No patterns found. Run "Codelab: Extract Patterns" first.'
		);
		return null;
	}

	const patternsContent = fs.readFileSync(patternsPath, 'utf-8');
	const patternsHash = sha256(patternsContent);

	// Collect files to check
	progress.report({ message: 'Finding files to check...' });
	let filesToCheck: CollectedFile[];

	try {
		filesToCheck = collectFiles(rootPath);
	} catch {
		return null;
	}

	if (filesToCheck.length === 0) {
		vscode.window.showInformationMessage('No files to check.');
		return null;
	}

	progress.report({ message: `Checking ${filesToCheck.length} files against patterns...` });

	const systemPrompt = getConformancePrompt();
	const userMessage = buildConformanceMessage(patternsContent, filesToCheck);

	const result = await runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress);

	if (!result.success) {
		vscode.window.showErrorMessage(`Conformance check failed: ${result.error}`);
		return null;
	}

	// Parse JSON output
	try {
		const cleaned = result.output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
		const rawIssues: ConformanceIssue[] = JSON.parse(cleaned);
		const validIssues = rawIssues.filter(
			(i) => i.file && typeof i.line === 'number' && i.message
		);

		// Build a map of file contents for hashing and line text lookup
		const fileContentMap = new Map<string, string>();
		for (const f of filesToCheck) {
			fileContentMap.set(f.relativePath, f.content);
		}

		// Enrich issues with originalLineText and fileHash
		const persistedIssues: PersistedIssue[] = validIssues.map((issue) => {
			const content = fileContentMap.get(issue.file) ?? '';
			const lines = content.split('\n');
			const originalLineText = (issue.line >= 1 && issue.line <= lines.length)
				? lines[issue.line - 1]
				: '';
			const fileHash = sha256(content);

			return {
				...issue,
				originalLineText,
				fileHash,
			};
		});

		return { issues: persistedIssues, patternsHash };
	} catch {
		vscode.window.showErrorMessage('Failed to parse conformance results. Claude may have returned invalid JSON.');
		return null;
	}
}
