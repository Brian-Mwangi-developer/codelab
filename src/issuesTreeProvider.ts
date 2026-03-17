import * as vscode from 'vscode';
import * as path from 'path';
import { ConformanceIssue } from './conformanceChecker';

export class IssueItem extends vscode.TreeItem {
	constructor(
		public readonly issue: ConformanceIssue,
		public readonly workspaceRoot: string
	) {
		super(issue.message, vscode.TreeItemCollapsibleState.None);

		const fullPath = path.join(workspaceRoot, issue.file);
		this.description = `${issue.file}:${issue.line}`;
		this.tooltip = new vscode.MarkdownString(
			`**${issue.severity.toUpperCase()}**: ${issue.message}\n\n` +
			`**Rule**: ${issue.rule}\n\n` +
			`**Fix**: ${issue.suggestion}`
		);

		this.iconPath = new vscode.ThemeIcon(
			issue.severity === 'error' ? 'error' : 'warning',
			issue.severity === 'error'
				? new vscode.ThemeColor('list.errorForeground')
				: new vscode.ThemeColor('list.warningForeground')
		);
		
		this.command = {
			command: 'vscode.open',
			title: 'Open File',
			arguments: [
				vscode.Uri.file(fullPath),
				{
					selection: new vscode.Range(
						issue.line - 1, issue.column,
						issue.line - 1, issue.column
					),
				} as vscode.TextDocumentShowOptions,
			],
		};
	}
}

export class FileGroupItem extends vscode.TreeItem {
	constructor(
		public readonly filePath: string,
		public readonly issues: ConformanceIssue[],
		public readonly workspaceRoot: string
	) {
		super(filePath, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
		this.iconPath = new vscode.ThemeIcon('file');
	}
}

export class IssuesTreeProvider implements vscode.TreeDataProvider<FileGroupItem | IssueItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private issues: ConformanceIssue[] = [];
	private workspaceRoot = '';

	setIssues(issues: ConformanceIssue[], workspaceRoot: string): void {
		this.issues = issues;
		this.workspaceRoot = workspaceRoot;
		this._onDidChangeTreeData.fire();
	}

	getIssues(): ConformanceIssue[] {
		return this.issues;
	}

	getTreeItem(element: FileGroupItem | IssueItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: FileGroupItem | IssueItem): (FileGroupItem | IssueItem)[] {
		if (!element) {
			// Root level: group by file
			const grouped = new Map<string, ConformanceIssue[]>();
			for (const issue of this.issues) {
				const existing = grouped.get(issue.file) || [];
				existing.push(issue);
				grouped.set(issue.file, existing);
			}

			if (grouped.size === 0) {
				return [];
			}

			return Array.from(grouped.entries()).map(
				([filePath, issues]) => new FileGroupItem(filePath, issues, this.workspaceRoot)
			);
		}

		if (element instanceof FileGroupItem) {
			return element.issues.map((issue) => new IssueItem(issue, this.workspaceRoot));
		}

		return [];
	}
}
