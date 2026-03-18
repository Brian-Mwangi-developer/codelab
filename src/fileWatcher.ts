import * as vscode from 'vscode';
import { PersistedIssue, saveConformance } from './persistenceManager';

export interface IssueProviders {
	updateAll(issues: PersistedIssue[], workspaceRoot: string): void;
}


export class FileWatcher implements vscode.Disposable {
	private disposable: vscode.Disposable;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private issues: PersistedIssue[] = [];
	private patternsHash = '';
	private workspaceRoot = '';
	private providers: IssueProviders | undefined;

	constructor() {
		this.disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
			this.onFileSaved(doc);
		});
	}

	setContext(issues: PersistedIssue[], patternsHash: string, workspaceRoot: string, providers: IssueProviders): void {
		this.issues = issues;
		this.patternsHash = patternsHash;
		this.workspaceRoot = workspaceRoot;
		this.providers = providers;
	}

	getIssues(): PersistedIssue[] {
		return this.issues;
	}

	private onFileSaved(document: vscode.TextDocument): void {
		if (!this.workspaceRoot || this.issues.length === 0) {
			return;
		}

		const relativePath = vscode.workspace.asRelativePath(document.uri);
		const fileIssues = this.issues.filter((i) => i.file === relativePath);

		if (fileIssues.length === 0) {
			return;
		}

		// Debounce at 300ms
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.resolveIssues(document, relativePath);
		}, 300);
	}

	private resolveIssues(document: vscode.TextDocument, relativePath: string): void {
		const survivingIssues: PersistedIssue[] = [];
		let changed = false;

		for (const issue of this.issues) {
			if (issue.file !== relativePath) {
				survivingIssues.push(issue);
				continue;
			}

			const lineIndex = issue.line - 1;

			// Line was deleted
			if (lineIndex >= document.lineCount) {
				changed = true;
				continue;
			}

			const currentLineText = document.lineAt(lineIndex).text;

			// Line content changed → issue likely resolved(will be updated for Better Implementation)
			if (currentLineText !== issue.originalLineText) {
				changed = true;
				continue;
			}

			survivingIssues.push(issue);
		}

		if (!changed) {
			return;
		}

		this.issues = survivingIssues;

		// Update all providers
		if (this.providers) {
			this.providers.updateAll(this.issues, this.workspaceRoot);
		}

		// Persist updated state
		if (this.workspaceRoot && this.patternsHash) {
			saveConformance(this.workspaceRoot, this.issues, this.patternsHash);
		}
	}

	dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.disposable.dispose();
	}
}
