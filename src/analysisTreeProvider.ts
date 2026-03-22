import * as vscode from 'vscode';
import { AnalysisFinding } from './prompt';

export class FindingItem extends vscode.TreeItem {
	constructor(
		public readonly finding: AnalysisFinding,
		public readonly workspaceRoot: string
	) {
		super(finding.title, vscode.TreeItemCollapsibleState.None);

		const fileLabel = finding.files.length > 0
			? finding.files.length === 1
				? finding.files[0]
				: `${finding.files.length} files`
			: '';
		this.description = fileLabel;

		this.tooltip = new vscode.MarkdownString(
			`**${finding.severity.toUpperCase()}** — ${finding.category}\n\n` +
			`${finding.description}\n\n` +
			`**Impact**: ${finding.impact}\n\n` +
			`**Fix**: ${finding.recommendation}`
		);

		const iconId = finding.severity === 'critical' ? 'error'
			: finding.severity === 'warning' ? 'warning'
			: 'info';
		const colorId = finding.severity === 'critical' ? 'list.errorForeground'
			: finding.severity === 'warning' ? 'list.warningForeground'
			: 'list.deemphasizedForeground';

		this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(colorId));

		// If there are line references, open the first one on click
		if (finding.lines && finding.lines.length > 0) {
			const loc = finding.lines[0];
			const fullPath = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), loc.file);
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [
					fullPath,
					{
						selection: new vscode.Range(
							Math.max(0, loc.start - 1), 0,
							Math.max(0, loc.end - 1), 0
						),
					} as vscode.TextDocumentShowOptions,
				],
			};
		} else if (finding.files.length > 0) {
			const fullPath = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), finding.files[0]);
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [fullPath],
			};
		}
	}
}

export class SeverityGroupItem extends vscode.TreeItem {
	constructor(
		public readonly severity: string,
		public readonly findings: AnalysisFinding[],
		public readonly workspaceRoot: string
	) {
		super(
			`${severity === 'critical' ? 'Critical' : severity === 'warning' ? 'Warnings' : 'Info'} (${findings.length})`,
			vscode.TreeItemCollapsibleState.Expanded
		);

		const iconId = severity === 'critical' ? 'error'
			: severity === 'warning' ? 'warning'
			: 'info';
		const colorId = severity === 'critical' ? 'list.errorForeground'
			: severity === 'warning' ? 'list.warningForeground'
			: 'list.deemphasizedForeground';

		this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(colorId));
	}
}

export type AnalysisState = 'idle' | 'clean' | 'has-findings';

export class AnalysisTreeProvider implements vscode.TreeDataProvider<SeverityGroupItem | FindingItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private findings: AnalysisFinding[] = [];
	private workspaceRoot = '';
	private _state: AnalysisState = 'idle';

	get state(): AnalysisState { return this._state; }

	setFindings(findings: AnalysisFinding[], workspaceRoot: string): void {
		this.findings = findings;
		this.workspaceRoot = workspaceRoot;
		this._state = findings.length > 0 ? 'has-findings' : 'clean';
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: SeverityGroupItem | FindingItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: SeverityGroupItem | FindingItem): (SeverityGroupItem | FindingItem)[] {
		if (!element) {
			// Root: group by severity
			const groups: { severity: string; findings: AnalysisFinding[] }[] = [];

			const critical = this.findings.filter(f => f.severity === 'critical');
			const warnings = this.findings.filter(f => f.severity === 'warning');
			const info = this.findings.filter(f => f.severity === 'info');

			if (critical.length > 0) { groups.push({ severity: 'critical', findings: critical }); }
			if (warnings.length > 0) { groups.push({ severity: 'warning', findings: warnings }); }
			if (info.length > 0) { groups.push({ severity: 'info', findings: info }); }

			return groups.map(g => new SeverityGroupItem(g.severity, g.findings, this.workspaceRoot));
		}

		if (element instanceof SeverityGroupItem) {
			return element.findings.map(f => new FindingItem(f, this.workspaceRoot));
		}

		return [];
	}
}
