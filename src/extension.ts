import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles, countFiles } from './fileCollector';
import { runClaudeAnalysis } from './claudeIntegration';
import {
	getSystemPrompt, getAgentFilePrompt,
	buildUserMessage, buildAgentFileMessage,
} from './prompt';
import { checkConformance } from './conformanceChecker';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { initDiagnostics, updateDiagnostics } from './diagnosticsProvider';
import { CodelabHoverProvider } from './hoverProvider';
import { CodelabCodeActionProvider } from './codeActionProvider';

export function activate(context: vscode.ExtensionContext) {

	const issuesTree = new IssuesTreeProvider();
	const hoverProvider = new CodelabHoverProvider();
	const codeActionProvider = new CodelabCodeActionProvider();
	const diagnostics = initDiagnostics();

	const treeView = vscode.window.createTreeView('codelab.issuesView', {
		treeDataProvider: issuesTree,
		showCollapseAll: true,
	});

	// --- Register Hover + CodeAction for all languages ---
	const allFiles: vscode.DocumentFilter = { scheme: 'file' };

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(allFiles, hoverProvider),
		vscode.languages.registerCodeActionsProvider(allFiles, codeActionProvider, {
			providedCodeActionKinds: CodelabCodeActionProvider.providedCodeActionKinds,
		}),
	);

	const countCmd = vscode.commands.registerCommand('codelab.countFiles', () => {
		const rootPath = getWorkspaceRoot();
		if (!rootPath) { return; }

		const fileCount = countFiles(rootPath);
		if (fileCount === 0) {
			vscode.window.showInformationMessage('No files found.');
		} else {
			vscode.window.showInformationMessage(`${fileCount} files found.`);
		}
	});

	const extractCmd = vscode.commands.registerCommand('codelab.extractPatterns', async () => {
		const rootPath = getWorkspaceRoot();
		if (!rootPath) { return; }

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Extracting Patterns',
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'Scanning workspace files...' });
				const files = collectFiles(rootPath);

				if (files.length === 0) {
					vscode.window.showInformationMessage('No files found to analyze.');
					return;
				}

				progress.report({ message: `Found ${files.length} files. Analyzing patterns...` });

				const systemPrompt = getSystemPrompt();
				const userMessage = buildUserMessage(files);
				const result = await runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress);

				if (!result.success) {
					vscode.window.showErrorMessage(`Pattern extraction failed: ${result.error}`);
					return;
				}

				progress.report({ message: 'Saving patterns...' });
				const codelabDir = path.join(rootPath, '.codelab');
				if (!fs.existsSync(codelabDir)) {
					fs.mkdirSync(codelabDir, { recursive: true });
				}

				const patternsPath = path.join(codelabDir, 'patterns.md');
				fs.writeFileSync(patternsPath, result.output, 'utf-8');

				progress.report({ message: 'Generating agent configuration files...' });
				const agentPrompt = getAgentFilePrompt();
				const agentMessage = buildAgentFileMessage(result.output);
				const agentResult = await runClaudeAnalysis(agentPrompt, agentMessage, rootPath, progress);

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
		const rootPath = getWorkspaceRoot();
		if (!rootPath) { return; }

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Codelab: Checking Conformance',
				cancellable: false,
			},
			async (progress) => {
				const issues = await checkConformance(rootPath, progress);

				issuesTree.setIssues(issues, rootPath);
				hoverProvider.setIssues(issues, rootPath);
				codeActionProvider.setIssues(issues, rootPath);
				updateDiagnostics(issues, rootPath);

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
		countCmd, extractCmd, checkCmd, refreshCmd,
		statusBarItem, treeView, diagnostics,
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
