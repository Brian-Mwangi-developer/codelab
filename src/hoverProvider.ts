import * as vscode from 'vscode';
import { ConformanceIssue } from './conformanceChecker';

export class CodelabHoverProvider implements vscode.HoverProvider {
	private issues: ConformanceIssue[] = [];
	private workspaceRoot = '';

	setIssues(issues: ConformanceIssue[], workspaceRoot: string): void {
		this.issues = issues;
		this.workspaceRoot = workspaceRoot;
	}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const relativePath = vscode.workspace.asRelativePath(document.uri);

		const matchingIssues = this.issues.filter(
			(i) => i.file === relativePath && i.line - 1 === position.line
		);

		if (matchingIssues.length === 0) {
			return undefined;
		}

		const parts: vscode.MarkdownString[] = matchingIssues.map((issue) => {
			const md = new vscode.MarkdownString();
			md.isTrusted = true;
			md.appendMarkdown(`### (${issue.severity === 'error' ? 'error' : 'warning'}) Codelab: ${issue.message}\n\n`);
			md.appendMarkdown(`**Rule**: ${issue.rule}\n\n`);
			md.appendMarkdown(`**Suggestion**: ${issue.suggestion}\n\n`);
			md.appendMarkdown(`---\n*Source: .codelab/patterns.md*`);
			return md;
		});

		return new vscode.Hover(parts);
	}
}
