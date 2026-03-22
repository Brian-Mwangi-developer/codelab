import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CodelabScope, loadScope, saveScope } from './scopeManager';

// Same dirs fileCollector ignores — no point showing them in scope picker
const SKIP_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.venv', 'venv',
	'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '.codelab',
]);

// ─────────────────────────────────────────────
// Mode header item (top of tree, clickable)
// ─────────────────────────────────────────────
export class ScopeModeItem extends vscode.TreeItem {
	readonly kind = 'mode' as const;

	constructor(mode: 'exclude' | 'include') {
		const isExclude = mode === 'exclude';
		super(
			isExclude
				? '$(eye-closed)  Exclude mode — checked items are IGNORED'
				: '$(eye)  Include-only mode — only CHECKED items are analyzed',
			vscode.TreeItemCollapsibleState.None
		);
		this.tooltip = isExclude
			? 'Check a file/folder to exclude it from analysis. Click here to switch to include-only mode.'
			: 'Check a file/folder to include it in analysis. Unchecked items are skipped. Click here to switch to exclude mode.';
		this.command = {
			command: 'codelab.toggleScopeMode',
			title: 'Toggle Scope Mode',
			arguments: [],
		};
		this.contextValue = 'scopeMode';
	}
}

// ─────────────────────────────────────────────
// File / Folder item with checkbox
// ─────────────────────────────────────────────
export class ScopeFileItem extends vscode.TreeItem {
	readonly kind = 'file' as const;

	constructor(
		public readonly relativePath: string,
		public readonly fullPath: string,
		public readonly isDirectory: boolean,
		checked: boolean,
	) {
		super(
			path.basename(relativePath),
			isDirectory
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);

		this.checkboxState = checked
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;

		this.resourceUri = vscode.Uri.file(fullPath);
		this.description = isDirectory ? '' : undefined;

		if (!isDirectory) {
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [this.resourceUri],
			};
		}
	}
}

export type ScopeItem = ScopeModeItem | ScopeFileItem;

// ─────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────
export class ScopeTreeProvider implements vscode.TreeDataProvider<ScopeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<ScopeItem | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private rootPath = '';
	private scope: CodelabScope = { mode: 'exclude', patterns: [] };

	setRoot(rootPath: string): void {
		this.rootPath = rootPath;
		this.scope = loadScope(rootPath);
		this._onDidChangeTreeData.fire();
	}

	refresh(): void {
		if (this.rootPath) {
			this.scope = loadScope(this.rootPath);
		}
		this._onDidChangeTreeData.fire();
	}

	getScope(): CodelabScope { return this.scope; }

	getTreeItem(element: ScopeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ScopeItem): ScopeItem[] {
		if (!this.rootPath) { return []; }

		if (!element) {
			// Root: mode header + top-level entries
			const modeItem = new ScopeModeItem(this.scope.mode);
			return [modeItem, ...this._getEntries('')];
		}

		if (element instanceof ScopeFileItem && element.isDirectory) {
			return this._getEntries(element.relativePath);
		}

		return [];
	}

	private _getEntries(relDir: string): ScopeFileItem[] {
		const absDir = relDir ? path.join(this.rootPath, relDir) : this.rootPath;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const items: ScopeFileItem[] = [];

		for (const entry of entries) {
			if (SKIP_DIRS.has(entry.name)) { continue; }

			const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
			const fullPath = path.join(this.rootPath, relPath);
			const isDir = entry.isDirectory();

			// Hidden dirs/files: only skip if they are common noise
			// (show .env, .eslintrc etc so users can explicitly scope them)
			if (entry.name.startsWith('.') && isDir) { continue; }

			const checked = this._isChecked(relPath, isDir);
			items.push(new ScopeFileItem(relPath, fullPath, isDir, checked));
		}

		// Sort: folders first, then alphabetical
		items.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
			return a.relativePath.localeCompare(b.relativePath);
		});

		return items;
	}

	/**
	 * An item is "checked" if any of its patterns (or a parent dir pattern) is in scope.patterns.
	 */
	private _isChecked(relPath: string, isDir: boolean): boolean {
		const exactPattern = isDir ? `${relPath}/**` : relPath;
		if (this.scope.patterns.includes(exactPattern)) { return true; }
		if (this.scope.patterns.includes(relPath)) { return true; }

		// Also check if a parent folder pattern covers this path
		for (const p of this.scope.patterns) {
			if (p.endsWith('/**')) {
				const parentDir = p.slice(0, -3);
				if (relPath.startsWith(parentDir + '/')) { return true; }
			}
		}
		return false;
	}

	/**
	 * Called by extension when the user clicks a checkbox.
	 */
	handleCheckboxChange(item: ScopeFileItem, checked: vscode.TreeItemCheckboxState): void {
		const pattern = item.isDirectory ? `${item.relativePath}/**` : item.relativePath;
		const isChecked = checked === vscode.TreeItemCheckboxState.Checked;

		if (isChecked) {
			if (!this.scope.patterns.includes(pattern)) {
				this.scope.patterns.push(pattern);
			}
			// If a parent was checked, no need to also add child — leave as-is
		} else {
			// Remove exact pattern and the bare path variant
			this.scope.patterns = this.scope.patterns.filter(
				p => p !== pattern && p !== item.relativePath
			);
		}

		if (this.rootPath) {
			saveScope(this.rootPath, this.scope);
		}
		this._onDidChangeTreeData.fire();
	}

	toggleMode(): void {
		this.scope.mode = this.scope.mode === 'exclude' ? 'include' : 'exclude';
		if (this.rootPath) {
			saveScope(this.rootPath, this.scope);
		}
		this._onDidChangeTreeData.fire();
	}
}
