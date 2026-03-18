import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { collectFiles } from './fileCollector';
import { runClaudeAnalysis } from './claudeIntegration';
import {
	AnalysisCategory, AnalysisFinding,
	getDeepAnalysisPlanPrompt, getDeepAnalysisCategoryPrompt, getDeepAnalysisCompilerPrompt,
	buildDeepAnalysisPlanMessage, buildDeepAnalysisCategoryMessage, buildDeepAnalysisCompilerMessage,
} from './prompt';

const CATEGORIES: AnalysisCategory[] = ['redundancy', 'implementation', 'performance', 'security'];

export async function runDeepAnalysis(
	rootPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<AnalysisFinding[]> {
	// Read patterns for context
	const patternsPath = path.join(rootPath, '.codelab', 'patterns.md');
	if (!fs.existsSync(patternsPath)) {
		vscode.window.showWarningMessage(
			'No patterns found. Run "Codelab: Extract Patterns" first.'
		);
		return [];
	}

	const patternsContent = fs.readFileSync(patternsPath, 'utf-8');

	// Collect files
	progress.report({ message: 'Collecting files for deep analysis...' });
	const files = collectFiles(rootPath);
	if (files.length === 0) {
		vscode.window.showInformationMessage('No files found to analyze.');
		return [];
	}

	// Ensure analysis directory
	const analysisDir = path.join(rootPath, '.codelab', 'analysis');
	if (!fs.existsSync(analysisDir)) {
		fs.mkdirSync(analysisDir, { recursive: true });
	}

	// Step 1: Opus plans the analysis
	progress.report({ message: 'Planning analysis strategy (opus)...' });
	const planPrompt = getDeepAnalysisPlanPrompt();
	const planMessage = buildDeepAnalysisPlanMessage(patternsContent, files);
	const planResult = await runClaudeAnalysis(planPrompt, planMessage, rootPath, progress, 'opus');

	let planContext = '';
	if (planResult.success) {
		planContext = planResult.output;
	} else {
		// If opus planning fails, continue with a generic plan
		planContext = '{"overview": "General codebase analysis", "focusAreas": {}}';
		vscode.window.showWarningMessage('Codelab: Analysis planning step failed. Proceeding with default strategy.');
	}

	// Step 2: 4x Sonnet agents run in parallel
	progress.report({ message: 'Running 4 specialist agents in parallel (sonnet)...' });

	const categoryPromises = CATEGORIES.map(async (category) => {
		const systemPrompt = getDeepAnalysisCategoryPrompt(category);
		const userMessage = buildDeepAnalysisCategoryMessage(category, planContext, files);
		const result = await runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress, 'sonnet');

		if (result.success) {
			// Save category output
			fs.writeFileSync(
				path.join(analysisDir, `${category}.md`),
				`# ${category.charAt(0).toUpperCase() + category.slice(1)} Analysis\n\n${result.output}`,
				'utf-8'
			);
		}

		return { category, result };
	});

	const categoryResults = await Promise.all(categoryPromises);

	// Collect outputs for compilation
	const categoryOutputs: Record<string, string> = {};
	for (const { category, result } of categoryResults) {
		if (result.success) {
			categoryOutputs[category] = result.output;
		} else {
			vscode.window.showWarningMessage(`Codelab: ${category} analysis failed — ${result.error}`);
			categoryOutputs[category] = '[]';
		}
	}

	// Step 3: Opus compiles findings
	progress.report({ message: 'Compiling analysis results (opus)...' });
	const compilerPrompt = getDeepAnalysisCompilerPrompt();
	const compilerMessage = buildDeepAnalysisCompilerMessage(categoryOutputs);
	const compiled = await runClaudeAnalysis(compilerPrompt, compilerMessage, rootPath, progress, 'opus');

	if (!compiled.success) {
		// Fall back to concatenating raw results
		vscode.window.showWarningMessage('Codelab: Compilation failed. Showing raw category results.');
		return parseRawCategoryOutputs(categoryOutputs);
	}

	// Save summary
	fs.writeFileSync(path.join(analysisDir, 'summary.md'), compiled.output, 'utf-8');

	// Parse compiled JSON
	try {
		const cleaned = compiled.output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
		const findings: AnalysisFinding[] = JSON.parse(cleaned);
		return findings.filter(f => f.title && f.category && f.severity);
	} catch {
		// Try parsing raw outputs as fallback
		vscode.window.showWarningMessage('Codelab: Could not parse compiled results. Showing raw findings.');
		return parseRawCategoryOutputs(categoryOutputs);
	}
}

function parseRawCategoryOutputs(outputs: Record<string, string>): AnalysisFinding[] {
	const findings: AnalysisFinding[] = [];

	for (const [, output] of Object.entries(outputs)) {
		try {
			const cleaned = output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
			const parsed: AnalysisFinding[] = JSON.parse(cleaned);
			findings.push(...parsed.filter(f => f.title && f.category && f.severity));
		} catch {
			// Skip unparseable output
		}
	}

	return findings;
}
