import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles, countFiles } from './fileCollector';
import { runClaudeAnalysis } from './claudeIntegration';
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
	}

	// --- Load persisted conformance on activation ---
	const rootPath = getWorkspaceRoot();
	if (rootPath) {
		const cached = loadConformance(rootPath);
		if (cached) {
			const validIssues = validateConformance(rootPath, cached);
			if (validIssues.length > 0) {
				updateAllProviders(validIssues, rootPath);
				fileWatcher.setContext(validIssues, cached.patternsHash, rootPath, { updateAll: updateAllProviders });
			} else if (cached.issues.length > 0) {
				vscode.window.showInformationMessage('Codelab: Cached issues invalidated (files or patterns changed). Re-run conformance check.');
			}
		}
	}

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

		const fileCount = countFiles(root);
		if (fileCount === 0) {
			vscode.window.showInformationMessage('No files found.');
		} else {
			vscode.window.showInformationMessage(`${fileCount} files found.`);
		}
	});

	const extractCmd = vscode.commands.registerCommand('codelab.extractPatterns', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Extracting Patterns',
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'Scanning workspace files...' });
				const files = collectFiles(root);

				if (files.length === 0) {
					vscode.window.showInformationMessage('No files found to analyze.');
					return;
				}

				progress.report({ message: `Found ${files.length} files. Analyzing patterns...` });

				// Use orchestrator — handles both small and large codebases
				const patternsOutput = await orchestratePatternExtraction(files, root, progress);

				if (!patternsOutput) {
					return;
				}

				progress.report({ message: 'Saving patterns...' });
				const codelabDir = path.join(root, '.codelab');
				if (!fs.existsSync(codelabDir)) {
					fs.mkdirSync(codelabDir, { recursive: true });
				}

				const patternsPath = path.join(codelabDir, 'patterns.md');
				fs.writeFileSync(patternsPath, patternsOutput, 'utf-8');

				progress.report({ message: 'Generating agent configuration files...' });
				const agentPrompt = getAgentFilePrompt();
				const agentMessage = buildAgentFileMessage(patternsOutput);
				const agentResult = await runClaudeAnalysis(agentPrompt, agentMessage, root, progress);

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

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Checking Conformance',
				cancellable: false,
			},
			async (progress) => {
				const result = await checkConformance(root, progress);

				if (!result) {
					updateAllProviders([], root);
					return;
				}

				const { issues, patternsHash } = result;

				updateAllProviders(issues, root);

				
				saveConformance(root, issues, patternsHash);

				// Update file watcher context
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


	// --- Push Guard Toggle ---
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

	// --- Deep Analysis ---
	const deepAnalysisCmd = vscode.commands.registerCommand('codelab.runDeepAnalysis', async () => {
		const root = getWorkspaceRoot();
		if (!root) { return; }

		const confirm = await vscode.window.showWarningMessage(
			'Deep analysis uses Opus (expensive) + Sonnet agents. This may take several minutes and incur significant API costs.',
			'Run Analysis',
			'Cancel'
		);
		if (confirm !== 'Run Analysis') { return; }

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Deep Analysis',
				cancellable: false,
			},
			async (progress) => {
				const findings = await runDeepAnalysis(root, progress);

				analysisTree.setFindings(findings, root);

				if (findings.length === 0) {
					vscode.window.showInformationMessage('Deep analysis found no issues.');
				} else {
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

	const refreshCmd = vscode.commands.registerCommand('codelab.refreshIssues', () => {
		vscode.commands.executeCommand('codelab.checkConformance');
	});

	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.text = '$(search) Extract Patterns';
	statusBarItem.tooltip = 'Codelab: Analyze codebase and extract engineering patterns';
	statusBarItem.command = 'codelab.extractPatterns';
	statusBarItem.show();

	context.subscriptions.push(
		countCmd, extractCmd, checkCmd, refreshCmd, togglePushGuardCmd, deepAnalysisCmd,
		statusBarItem, issueCountBar, treeView, analysisTreeView, diagnostics, fileWatcher,
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
