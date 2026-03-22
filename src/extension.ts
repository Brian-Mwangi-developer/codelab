import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles, countFiles } from './fileCollector';
import { runClaudeAnalysis, ensureClaudeAvailable } from './claudeIntegration';
import { getAgentFilePrompt, buildAgentFileMessage } from './prompt';
import { orchestratePatternExtraction } from './agentOrchestrator';
import { checkConformance } from './conformanceChecker';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { initDiagnostics, updateDiagnostics } from './diagnosticsProvider';
import { CodelabHoverProvider } from './hoverProvider';
import { CodelabCodeActionProvider } from './codeActionProvider';
import { PersistedIssue, loadConformance, validateConformance, saveConformance, loadSettings, saveSettings } from './persistenceManager';
import { FileWatcher } from './fileWatcher';
import { isPushGuardInstalled, installPushGuard, removePushGuard } from './gitGuard';
import { AnalysisTreeProvider } from './analysisTreeProvider';
import { runDeepAnalysis } from './deepAnalysis';
import { loadScope, saveScope, describeScopeMode } from './scopeManager';
import { ScopeTreeProvider, ScopeFileItem } from './scopeTreeProvider';

export function activate(context: vscode.ExtensionContext) {

	const issuesTree = new IssuesTreeProvider();
	const analysisTree = new AnalysisTreeProvider();
	const hoverProvider = new CodelabHoverProvider();
	const codeActionProvider = new CodelabCodeActionProvider();
	const diagnostics = initDiagnostics();
	const fileWatcher = new FileWatcher();

	const treeView = vscode.window.createTreeView('codelab.issuesView', {
		treeDataProvider: issuesTree,
		showCollapseAll: true,
	});

	const analysisTreeView = vscode.window.createTreeView('codelab.analysisView', {
		treeDataProvider: analysisTree,
		showCollapseAll: true,
	});

	const scopeTree = new ScopeTreeProvider();
	const scopeTreeView = vscode.window.createTreeView('codelab.scopeView', {
		treeDataProvider: scopeTree,
		showCollapseAll: false,
		manageCheckboxStateManually: false,
	});

	// Handle checkbox clicks in the scope tree
	scopeTreeView.onDidChangeCheckboxState(e => {
		for (const [item, state] of e.items) {
			if (item instanceof ScopeFileItem) {
				scopeTree.handleCheckboxChange(item, state);
			}
		}
	});

	treeView.message = 'Extract patterns then run "Check Conformance" to scan your codebase.';
	analysisTreeView.message = 'Run "Deep Analysis" to find code quality issues using Claude Opus.';

	
	const issueCountBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		99
	);
	issueCountBar.command = 'codelab.checkConformance';

	function updateIssueCountBar(count: number): void {
		if (count > 0) {
			issueCountBar.text = `$(warning) ${count} issue${count === 1 ? '' : 's'}`;
			issueCountBar.tooltip = `Codelab: ${count} conformance issue${count === 1 ? '' : 's'} — click to re-check`;
			issueCountBar.show();
		} else {
			issueCountBar.hide();
		}
	}

	function updateAllProviders(issues: PersistedIssue[], workspaceRoot: string): void {
		issuesTree.setIssues(issues, workspaceRoot);
		hoverProvider.setIssues(issues, workspaceRoot);
		codeActionProvider.setIssues(issues, workspaceRoot);
		updateDiagnostics(issues, workspaceRoot);
		updateIssueCountBar(issues.length);

		if (issues.length === 0) {
			treeView.message = 'No conformance issues found. All patterns are being followed.';
		} else {
			treeView.message = undefined;
		}
	}

	
	const rootPath = getWorkspaceRoot();
	if (rootPath) {
		// Initialise scope tree with workspace root
		scopeTree.setRoot(rootPath);

		const cached = loadConformance(rootPath);
		if (cached) {
			const validIssues = validateConformance(rootPath, cached);
			if (validIssues.length > 0) {
				updateAllProviders(validIssues, rootPath);
				fileWatcher.setContext(validIssues, cached.patternsHash, rootPath, { updateAll: updateAllProviders });
			} else if (cached.issues.length > 0) {
				treeView.message = 'Cached results are stale (files or patterns changed). Re-run "Check Conformance".';
				vscode.window.showInformationMessage('Codelab: Cached issues invalidated (files or patterns changed). Re-run conformance check.');
			}
		}
	}

	// --- Register Hover + CodeAction for all languages ---
	const allFiles: vscode.DocumentFilter = { scheme: 'file' };

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(allFiles, hoverProvider),
		vscode.languages.registerCodeActionsProvider(allFiles, codeActionProvider, {
			providedCodeActionKinds: CodelabCodeActionProvider.providedCodeActionKinds,
		}),
	);

	
	const countCmd = vscode.commands.registerCommand('codelab.countFiles', () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		const scope = loadScope(root);
		const fileCount = countFiles(root, scope);
		const scopeDesc = describeScopeMode(scope);

		if (fileCount === 0) {
			vscode.window.showInformationMessage(`No files found. Scope: ${scopeDesc}`);
		} else {
			vscode.window.showInformationMessage(`${fileCount} files found. Scope: ${scopeDesc}`);
		}
	});

	
	const extractCmd = vscode.commands.registerCommand('codelab.extractPatterns', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }
		if (!await ensureClaudeAvailable()) { return; }

		const scope = loadScope(root);

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Extracting Patterns',
				cancellable: true,
			},
			async (progress, token) => {
				progress.report({ message: 'Scanning workspace files...' });
				const files = collectFiles(root, scope);

				if (files.length === 0) {
					vscode.window.showInformationMessage('No files found to analyze. Check your scope settings.');
					return;
				}

				if (token.isCancellationRequested) { return; }

				const scopeDesc = describeScopeMode(scope);
				progress.report({ message: `Found ${files.length} files (${scopeDesc}). Analyzing patterns...` });

				const patternsOutput = await orchestratePatternExtraction(files, root, progress, undefined, token);

				if (!patternsOutput || token.isCancellationRequested) {
					if (token.isCancellationRequested) {
						vscode.window.showInformationMessage('Codelab: Pattern extraction cancelled.');
					}
					return;
				}

				progress.report({ message: 'Saving patterns...' });
				const codelabDir = path.join(root, '.codelab');
				if (!fs.existsSync(codelabDir)) {
					fs.mkdirSync(codelabDir, { recursive: true });
				}

				const patternsPath = path.join(codelabDir, 'patterns.md');
				fs.writeFileSync(patternsPath, patternsOutput, 'utf-8');

				if (token.isCancellationRequested) { return; }

				progress.report({ message: 'Generating agent configuration files...' });
				const agentPrompt = getAgentFilePrompt();
				const agentMessage = buildAgentFileMessage(patternsOutput);
				const agentResult = await runClaudeAnalysis(agentPrompt, agentMessage, root, progress, 'sonnet', token);

				if (agentResult.success) {
					const parts = agentResult.output.split('===CURSOR_RULES_SEPARATOR===');
					const claudeMd = parts[0]?.trim();
					const cursorRules = parts[1]?.trim();

					if (claudeMd) {
						fs.writeFileSync(path.join(codelabDir, 'CLAUDE.md'), claudeMd, 'utf-8');
					}
					if (cursorRules) {
						fs.writeFileSync(path.join(codelabDir, '.cursorrules'), cursorRules, 'utf-8');
					}
				}

				if (token.isCancellationRequested) { return; }

	
				treeView.message = 'Patterns extracted. Run "Check Conformance" to scan for issues.';

				const doc = await vscode.workspace.openTextDocument(patternsPath);
				await vscode.window.showTextDocument(doc);
				vscode.window.showInformationMessage(
					`Patterns extracted from ${files.length} files → .codelab/patterns.md, CLAUDE.md, .cursorrules`
				);
			}
		);
	});


	const checkCmd = vscode.commands.registerCommand('codelab.checkConformance', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }
		if (!await ensureClaudeAvailable()) { return; }

		const scope = loadScope(root);

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Checking Conformance',
				cancellable: true,
			},
			async (progress, token) => {
				const result = await checkConformance(root, progress, token, scope);

				if (!result) {
					if (token.isCancellationRequested) {
						vscode.window.showInformationMessage('Codelab: Conformance check cancelled.');
					} else {
						updateAllProviders([], root);
					}
					return;
				}

				const { issues, patternsHash } = result;

				updateAllProviders(issues, root);
				saveConformance(root, issues, patternsHash);
				fileWatcher.setContext(issues, patternsHash, root, { updateAll: updateAllProviders });

				if (issues.length === 0) {
					vscode.window.showInformationMessage('No conformance issues found.');
				} else {
					vscode.window.showWarningMessage(
						`Found ${issues.length} conformance issue${issues.length === 1 ? '' : 's'}. Check the Codelab sidebar.`
					);
					try {
						await treeView.reveal(undefined as never, { focus: true });
					} catch {
					}
				}
			}
		);
	});

	const togglePushGuardCmd = vscode.commands.registerCommand('codelab.togglePushGuard', () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		const settings = loadSettings(root);

		if (isPushGuardInstalled(root)) {
			removePushGuard(root);
			settings.pushGuardEnabled = false;
			saveSettings(root, settings);
			vscode.window.showInformationMessage('Codelab: Push guard disabled. Developers can push freely.');
		} else {
			const err = installPushGuard(root);
			if (err) {
				vscode.window.showWarningMessage(`Codelab: ${err}`);
				return;
			}
			settings.pushGuardEnabled = true;
			saveSettings(root, settings);
			vscode.window.showInformationMessage('Codelab: Push guard enabled. Pushes will be blocked if conformance errors exist.');
		}
	});

	const deepAnalysisCmd = vscode.commands.registerCommand('codelab.runDeepAnalysis', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }
		if (!await ensureClaudeAvailable()) { return; }

		const confirm = await vscode.window.showWarningMessage(
			'Deep analysis uses Opus + Sonnet agents. Requires a Claude Pro or higher subscription. This may take several minutes.',
			'Run Analysis',
			'Cancel'
		);
		if (confirm !== 'Run Analysis') { return; }

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Deep Analysis',
				cancellable: true,
			},
			async (progress, token) => {
				const findings = await runDeepAnalysis(root, progress, token);

				if (token.isCancellationRequested) {
					vscode.window.showInformationMessage('Codelab: Deep analysis cancelled.');
					return;
				}

				analysisTree.setFindings(findings, root);

				if (findings.length === 0) {
					analysisTreeView.message = 'Deep analysis found no issues. Your codebase looks great!';
					vscode.window.showInformationMessage('Deep analysis found no issues.');
				} else {
					analysisTreeView.message = undefined;
					const critical = findings.filter(f => f.severity === 'critical').length;
					const warnings = findings.filter(f => f.severity === 'warning').length;
					const info = findings.filter(f => f.severity === 'info').length;
					vscode.window.showInformationMessage(
						`Deep analysis complete: ${critical} critical, ${warnings} warnings, ${info} info. Check the Deep Analysis panel.`
					);
				}
			}
		);
	});

	const configureScopeCmd = vscode.commands.registerCommand('codelab.configureScope', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		const scope = loadScope(root);

		// Loop so the user can make multiple changes in one session
		while (true) {
			const modeLabel = scope.mode === 'exclude'
				? 'Exclude mode — ignore listed paths'
				: 'Include-only mode — analyze only listed paths';

			const patternItems: vscode.QuickPickItem[] = scope.patterns.map(p => ({
				label: `$(trash) ${p}`,
				description: 'Click to remove',
			}));

			const items: vscode.QuickPickItem[] = [
				{ label: `$(list-filter) Mode: ${modeLabel}`, description: 'Click to toggle' },
				{ label: '$(add) Add pattern manually', description: 'e.g. tests/**, *.test.ts, scripts/' },
				{ label: '$(file-directory) Pick folder to add', description: 'Browse and select a folder' },
				{ label: '$(trash) Clear all patterns', description: scope.patterns.length === 0 ? 'Nothing to clear' : `Remove all ${scope.patterns.length} pattern(s)` },
				{ label: '', kind: vscode.QuickPickItemKind.Separator },
				...(patternItems.length > 0
					? patternItems
					: [{ label: '$(info) No custom patterns — all files are included', description: '' }]),
			];

			const picked = await vscode.window.showQuickPick(items, {
				title: 'Codelab: Configure File Scope',
				placeHolder: 'Choose an action, or click a pattern to remove it',
			});

			if (!picked) { break; }

			if (picked.label.startsWith('$(list-filter)')) {
				scope.mode = scope.mode === 'exclude' ? 'include' : 'exclude';
				saveScope(root, scope);
				vscode.window.showInformationMessage(`Codelab scope: switched to ${scope.mode} mode.`);

			} else if (picked.label.startsWith('$(add)')) {
				const input = await vscode.window.showInputBox({
					prompt: 'Enter a glob pattern to add (e.g. tests/**, scripts/, *.spec.ts)',
					placeHolder: 'tests/**',
					validateInput: (v) => v.trim().length === 0 ? 'Pattern cannot be empty' : undefined,
				});
				if (input) {
					const pattern = input.trim();
					if (!scope.patterns.includes(pattern)) {
						scope.patterns.push(pattern);
						saveScope(root, scope);
					}
					vscode.window.showInformationMessage(`Codelab scope: added "${pattern}" to ${scope.mode} list.`);
				}

			} else if (picked.label.startsWith('$(file-directory)')) {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: true,
					openLabel: 'Add folder to Codelab scope',
					defaultUri: vscode.Uri.file(root),
				});
				if (uris && uris.length > 0) {
					for (const uri of uris) {
						const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/') + '/**';
						if (!scope.patterns.includes(rel)) {
							scope.patterns.push(rel);
						}
					}
					saveScope(root, scope);
					vscode.window.showInformationMessage(`Codelab scope: added ${uris.length} folder(s) to ${scope.mode} list.`);
				}

			} else if (picked.label.startsWith('$(trash) ') && !picked.label.includes('Clear all')) {
				const pattern = picked.label.replace('$(trash) ', '');
				scope.patterns = scope.patterns.filter(p => p !== pattern);
				saveScope(root, scope);

			} else if (picked.label.startsWith('$(trash) Clear all')) {
				if (scope.patterns.length > 0) {
					scope.patterns = [];
					saveScope(root, scope);
					vscode.window.showInformationMessage('Codelab scope: all patterns cleared.');
				}

			} else {
				break;
			}
		}
	});

	const ignoreCmd = vscode.commands.registerCommand('codelab.ignoreInCodelab', async (uri?: vscode.Uri) => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		
		if (!uri) {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Ignore in Codelab Analysis',
				defaultUri: vscode.Uri.file(root),
			});
			if (!picked || picked.length === 0) { return; }
			uri = picked[0];
		}

		const relPath = path.relative(root, uri.fsPath).replace(/\\/g, '/');
		let stat: fs.Stats;
		try {
			stat = fs.statSync(uri.fsPath);
		} catch {
			return;
		}

		const pattern = stat.isDirectory() ? `${relPath}/**` : relPath;
		const scope = loadScope(root);

		if (!scope.patterns.includes(pattern)) {
			
			if (scope.mode === 'include') {
				const choice = await vscode.window.showWarningMessage(
					`Codelab scope is in "include-only" mode. Do you want to switch to "exclude" mode to ignore "${pattern}"?`,
					'Switch to Exclude Mode',
					'Cancel'
				);
				if (choice !== 'Switch to Exclude Mode') { return; }
				scope.mode = 'exclude';
			}
			scope.patterns.push(pattern);
			saveScope(root, scope);
			vscode.window.showInformationMessage(`Codelab: Ignoring "${pattern}"`);
		} else {
			vscode.window.showInformationMessage(`Codelab: "${pattern}" is already in the ignore list.`);
		}
	});

	const toggleScopeModeCmd = vscode.commands.registerCommand('codelab.toggleScopeMode', () => {
		scopeTree.toggleMode();
	});

	const refreshCmd = vscode.commands.registerCommand('codelab.refreshIssues', () => {
		vscode.commands.executeCommand('codelab.checkConformance');
	});

	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	
	statusBarItem.tooltip = 'Codelab: Analyze codebase and extract engineering patterns';
	statusBarItem.show();

	context.subscriptions.push(
		countCmd, extractCmd, checkCmd, refreshCmd, togglePushGuardCmd,
		deepAnalysisCmd, configureScopeCmd, ignoreCmd, toggleScopeModeCmd,
		statusBarItem, issueCountBar, treeView, analysisTreeView, scopeTreeView, diagnostics, fileWatcher,
	);
}

function getWorkspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showInformationMessage('No workspace folder is open.');
		return undefined;
	}
	return folders[0].uri.fsPath;
}

export function deactivate() {}
