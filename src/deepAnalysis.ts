import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectFiles, CollectedFile } from './fileCollector';
import { CodelabScope } from './scopeManager';
import { runClaudeAnalysis } from './claudeIntegration';
import { chunkFiles } from './agentOrchestrator';
import {
	AnalysisCategory, AnalysisFinding,
	getDeepAnalysisPlanPrompt, getDeepAnalysisCategoryPrompt, getDeepAnalysisCompilerPrompt,
	getDeepAnalysisChunkPrompt, getDeepAnalysisCategoryCompilerPrompt,
	buildDeepAnalysisPlanMessage, buildDeepAnalysisCategoryMessage, buildDeepAnalysisCompilerMessage,
	buildDeepAnalysisChunkMessage, buildDeepAnalysisCategoryCompilerMessage,
} from './prompt';

const CATEGORIES: AnalysisCategory[] = ['redundancy', 'implementation', 'performance', 'security'];
const CHUNK_THRESHOLD = 50;
const MAX_PARALLEL_CHUNK_AGENTS = 5;

export async function runDeepAnalysis(
	rootPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken,
	scope?: CodelabScope
): Promise<AnalysisFinding[]> {
	const patternsPath = path.join(rootPath, '.codelab', 'patterns.md');
	if (!fs.existsSync(patternsPath)) {
		vscode.window.showWarningMessage('No patterns found. Run "Codelab: Extract Patterns" first.');
		return [];
	}
	const patternsContent = fs.readFileSync(patternsPath, 'utf-8');

	progress.report({ message: 'Collecting files for deep analysis...' });
	const files = collectFiles(rootPath, scope);
	if (files.length === 0) {
		vscode.window.showInformationMessage('No files found to analyze.');
		return [];
	}

	const analysisDir = path.join(rootPath, '.codelab', 'analysis');
	if (!fs.existsSync(analysisDir)) { fs.mkdirSync(analysisDir, { recursive: true }); }

	if (files.length <= CHUNK_THRESHOLD) {
		return runSmallAnalysis(rootPath, files, patternsContent, analysisDir, progress, token);
	} else {
		return runChunkedAnalysis(rootPath, files, patternsContent, analysisDir, progress, token);
	}
}

// --- Small codebase: Opus plan → 4×Sonnet → Opus compile ---

async function runSmallAnalysis(
	rootPath: string,
	files: CollectedFile[],
	patternsContent: string,
	analysisDir: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken
): Promise<AnalysisFinding[]> {
	progress.report({ message: `Analyzing ${files.length} files — planning strategy (opus)...` });
	const planResult = await runClaudeAnalysis(
		getDeepAnalysisPlanPrompt(),
		buildDeepAnalysisPlanMessage(patternsContent, files),
		rootPath, progress, 'opus', token
	);
	if (token?.isCancellationRequested) { return []; }

	const planContext = planResult.success
		? planResult.output
		: '{"overview": "General codebase analysis", "focusAreas": {}}';

	progress.report({ message: 'Running 4 specialist agents in parallel (sonnet)...' });
	const categoryResults = await Promise.all(
		CATEGORIES.map(async (category) => {
			const result = await runClaudeAnalysis(
				getDeepAnalysisCategoryPrompt(category),
				buildDeepAnalysisCategoryMessage(category, planContext, files),
				rootPath, progress, 'sonnet', token
			);
			if (result.success) {
				fs.writeFileSync(
					path.join(analysisDir, `${category}.md`),
					`# ${category} Analysis\n\n${result.output}`, 'utf-8'
				);
			}
			return { category, result };
		})
	);

	const categoryOutputs: Record<string, string> = {};
	for (const { category, result } of categoryResults) {
		categoryOutputs[category] = result.success ? result.output : '[]';
		if (!result.success) {
			vscode.window.showWarningMessage(`Codelab: ${category} analysis failed — ${result.error}`);
		}
	}

	return compileWithOpus(rootPath, categoryOutputs, analysisDir, progress, token);
}

// --- Large codebase: chunk → Haiku per chunk → Sonnet per category → Opus compile ---

async function runChunkedAnalysis(
	rootPath: string,
	files: CollectedFile[],
	patternsContent: string,
	analysisDir: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken
): Promise<AnalysisFinding[]> {
	const chunks = chunkFiles(files);
	progress.report({ message: `${files.length} files split into ${chunks.length} chunks. Planning analysis (opus)...` });

	// Opus plans using file paths only (no content — safe even at large scale)
	const planResult = await runClaudeAnalysis(
		getDeepAnalysisPlanPrompt(),
		buildDeepAnalysisPlanMessage(patternsContent, files),
		rootPath, progress, 'opus', token
	);
	if (token?.isCancellationRequested) { return []; }

	const planContext = planResult.success
		? planResult.output
		: '{"overview": "General codebase analysis", "focusAreas": {}}';

	const chunkAnalysisDir = path.join(analysisDir, 'chunks');
	if (!fs.existsSync(chunkAnalysisDir)) { fs.mkdirSync(chunkAnalysisDir, { recursive: true }); }

	// Run each category sequentially — each category runs parallel chunk batches internally
	const categoryOutputs: Record<string, string> = {};
	let catIndex = 0;

	for (const category of CATEGORIES) {
		if (token?.isCancellationRequested) { return []; }
		catIndex++;
		progress.report({ message: `[${catIndex}/4] ${category}: analyzing ${chunks.length} chunks with haiku agents...` });

		const chunkFindings: string[] = [];

		// Process chunks in parallel batches
		for (let i = 0; i < chunks.length; i += MAX_PARALLEL_CHUNK_AGENTS) {
			if (token?.isCancellationRequested) { return []; }

			const batch = chunks.slice(i, i + MAX_PARALLEL_CHUNK_AGENTS);
			const batchEnd = Math.min(i + MAX_PARALLEL_CHUNK_AGENTS, chunks.length);
			progress.report({ message: `[${catIndex}/4] ${category}: chunks ${i + 1}-${batchEnd} of ${chunks.length}...` });

			const batchResults = await Promise.all(
				batch.map((chunk, idx) => {
					const chunkIdx = i + idx;
					return runClaudeAnalysis(
						getDeepAnalysisChunkPrompt(category),
						buildDeepAnalysisChunkMessage(category, chunk, patternsContent, planContext),
						rootPath, progress, 'haiku', token
					).then((result) => {
						if (result.success) {
							const chunkLabel = `${category}-chunk-${String(chunkIdx + 1).padStart(3, '0')}`;
							const header = `# ${category.charAt(0).toUpperCase() + category.slice(1)} Analysis — Chunk ${chunkIdx + 1}\n`
								+ `> Files: ${chunk.map(f => f.relativePath).join(', ')}\n\n`
								+ `\`\`\`json\n${result.output}\n\`\`\`\n`;
							fs.writeFileSync(
								path.join(chunkAnalysisDir, `${chunkLabel}.md`),
								header, 'utf-8'
							);
						}
						return result;
					});
				})
			);

			for (const result of batchResults) {
				if (result.success) {
					chunkFindings.push(result.output);
				}
			}
		}

		if (chunkFindings.length === 0) {
			vscode.window.showWarningMessage(`Codelab: No chunk results for ${category}. Skipping.`);
			categoryOutputs[category] = '[]';
			continue;
		}

		// Sonnet compiles chunk findings for this category
		progress.report({ message: `[${catIndex}/4] ${category}: compiling ${chunkFindings.length} chunk results (sonnet)...` });
		const categoryCompiled = await runClaudeAnalysis(
			getDeepAnalysisCategoryCompilerPrompt(category),
			buildDeepAnalysisCategoryCompilerMessage(category, chunkFindings),
			rootPath, progress, 'sonnet', token
		);

		if (categoryCompiled.success) {
			fs.writeFileSync(path.join(analysisDir, `${category}.md`), categoryCompiled.output, 'utf-8');
			categoryOutputs[category] = categoryCompiled.output;
		} else {
			// Fall back to concatenating raw chunk findings
			const raw = chunkFindings.join('\n');
			categoryOutputs[category] = raw;
			vscode.window.showWarningMessage(`Codelab: ${category} compilation failed — using raw chunk results.`);
		}
	}

	return compileWithOpus(rootPath, categoryOutputs, analysisDir, progress, token);
}

// --- Final step shared by both paths ---

async function compileWithOpus(
	rootPath: string,
	categoryOutputs: Record<string, string>,
	analysisDir: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken
): Promise<AnalysisFinding[]> {
	if (token?.isCancellationRequested) { return []; }

	progress.report({ message: 'Compiling all findings (opus)...' });
	const compiled = await runClaudeAnalysis(
		getDeepAnalysisCompilerPrompt(),
		buildDeepAnalysisCompilerMessage(categoryOutputs),
		rootPath, progress, 'opus', token
	);

	if (!compiled.success) {
		vscode.window.showWarningMessage('Codelab: Final compilation failed. Showing raw category results.');
		return parseRawCategoryOutputs(categoryOutputs);
	}

	fs.writeFileSync(path.join(analysisDir, 'summary.md'), compiled.output, 'utf-8');

	try {
		const cleaned = compiled.output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
		const findings: AnalysisFinding[] = JSON.parse(cleaned);
		return findings.filter(f => f.title && f.category && f.severity);
	} catch {
		vscode.window.showWarningMessage('Codelab: Could not parse compiled results. Showing raw findings.');
		return parseRawCategoryOutputs(categoryOutputs);
	}
}

function parseRawCategoryOutputs(outputs: Record<string, string>): AnalysisFinding[] {
	const findings: AnalysisFinding[] = [];
	for (const output of Object.values(outputs)) {
		try {
			const cleaned = output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
			const parsed: AnalysisFinding[] = JSON.parse(cleaned);
			findings.push(...parsed.filter(f => f.title && f.category && f.severity));
		} catch { /* skip unparseable */ }
	}
	return findings;
}
