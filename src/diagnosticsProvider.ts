import * as vscode from 'vscode';
import * as path from 'path';
import { ConformanceIssue } from './conformanceChecker';

let diagnosticCollection: vscode.DiagnosticCollection;

export function initDiagnostics(): vscode.DiagnosticCollection {
	diagnosticCollection = vscode.languages.createDiagnosticCollection('codelab');
	return diagnosticCollection;
}

export function updateDiagnostics(issues: ConformanceIssue[], workspaceRoot: string): void {
	diagnosticCollection.clear();

	// Group by file
	const grouped = new Map<string, ConformanceIssue[]>();
	for (const issue of issues) {
		const existing = grouped.get(issue.file) || [];
		existing.push(issue);
		grouped.set(issue.file, existing);
	}

	for (const [filePath, fileIssues] of grouped) {
		const uri = vscode.Uri.file(path.join(workspaceRoot, filePath));
		const diagnostics: vscode.Diagnostic[] = fileIssues.map((issue) => {
			const range = new vscode.Range(
				Math.max(0, issue.line - 1), issue.column,
				Math.max(0, issue.line - 1), Number.MAX_SAFE_INTEGER
			);

			const severity = issue.severity === 'error'
				? vscode.DiagnosticSeverity.Error
				: vscode.DiagnosticSeverity.Warning;

			const diagnostic = new vscode.Diagnostic(range, issue.message, severity);
			diagnostic.source = 'Codelab';
			diagnostic.code = issue.rule;
			return diagnostic;
		});

		diagnosticCollection.set(uri, diagnostics);
	}
}
