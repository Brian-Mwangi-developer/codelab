import * as vscode from 'vscode';
import { ConformanceIssue } from './conformanceChecker';

export class CodelabCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
	];

	private issues: ConformanceIssue[] = [];
	private workspaceRoot = '';

	setIssues(issues: ConformanceIssue[], workspaceRoot: string): void {
		this.issues = issues;
		this.workspaceRoot = workspaceRoot;
	}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range
	): vscode.CodeAction[] {
		const relativePath = vscode.workspace.asRelativePath(document.uri);

		const matchingIssues = this.issues.filter(
			(i) =>
				i.file === relativePath &&
				i.line - 1 >= range.start.line &&
				i.line - 1 <= range.end.line
		);

		return matchingIssues.map((issue) => {
			const action = new vscode.CodeAction(
				`Codelab: ${issue.suggestion}`,
				vscode.CodeActionKind.QuickFix
			);

			action.diagnostics = [
				new vscode.Diagnostic(
					new vscode.Range(
						Math.max(0, issue.line - 1), issue.column,
						Math.max(0, issue.line - 1), Number.MAX_SAFE_INTEGER
					),
					issue.message,
					issue.severity === 'error'
						? vscode.DiagnosticSeverity.Error
						: vscode.DiagnosticSeverity.Warning
				),
			];

			action.isPreferred = true;
			return action;
		});
	}
}
