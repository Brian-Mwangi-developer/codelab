import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CollectedFile } from './fileCollector';
import { runClaudeAnalysis, ClaudeModel } from './claudeIntegration';
import {
	getSystemPrompt, getChunkPatternPrompt, getPatternCompilerPrompt,
	buildUserMessage, buildChunkMessage, buildCompilerMessage,
} from './prompt';

export interface ChunkConfig {
	maxFilesPerChunk: number;
	maxCharsPerChunk: number;
	maxParallelAgents: number;
	subAgentThreshold: number;
}

const DEFAULT_CONFIG: ChunkConfig = {
	maxFilesPerChunk: 30,
	maxCharsPerChunk: 150_000,
	maxParallelAgents: 5,
	subAgentThreshold: 50,
};


export function chunkFiles(files: CollectedFile[], config: ChunkConfig = DEFAULT_CONFIG): CollectedFile[][] {
	// Group by directory first
	const dirGroups = new Map<string, CollectedFile[]>();
	for (const file of files) {
		const dir = path.dirname(file.relativePath);
		const group = dirGroups.get(dir) || [];
		group.push(file);
		dirGroups.set(dir, group);
	}

	const chunks: CollectedFile[][] = [];
	let currentChunk: CollectedFile[] = [];
	let currentChars = 0;

	for (const group of dirGroups.values()) {
		for (const file of group) {
			const fileChars = file.content.length;

			// If adding this file would exceed limits, start a new chunk
			if (currentChunk.length > 0 &&
				(currentChunk.length >= config.maxFilesPerChunk || currentChars + fileChars > config.maxCharsPerChunk)) {
				chunks.push(currentChunk);
				currentChunk = [];
				currentChars = 0;
			}

			currentChunk.push(file);
			currentChars += fileChars;
		}
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}


export async function orchestratePatternExtraction(
	files: CollectedFile[],
	rootPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	config: ChunkConfig = DEFAULT_CONFIG,
	token?: vscode.CancellationToken
): Promise<string | null> {
	if (files.length <= config.subAgentThreshold) {
		// Single session — use sonnet directly
		progress.report({ message: `Analyzing ${files.length} files with single session...` });
		const systemPrompt = getSystemPrompt();
		const userMessage = buildUserMessage(files);
		const result = await runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress, 'sonnet', token);

		if (!result.success) {
			if (token?.isCancellationRequested) { return null; }
			vscode.window.showErrorMessage(`Pattern extraction failed: ${result.error}`);
			return null;
		}
		return result.output;
	}

	// Chunked parallel — use haiku sub-agents + sonnet compiler
	const chunks = chunkFiles(files, config);
	progress.report({ message: `Splitting ${files.length} files into ${chunks.length} chunks for parallel analysis...` });

	const codelabDir = path.join(rootPath, '.codelab');
	const patternsDir = path.join(codelabDir, 'patterns');
	if (!fs.existsSync(patternsDir)) {
		fs.mkdirSync(patternsDir, { recursive: true });
	}

	const chunkOutputs: string[] = [];
	const model: ClaudeModel = 'haiku';

	for (let i = 0; i < chunks.length; i += config.maxParallelAgents) {
		if (token?.isCancellationRequested) { return null; }

		const batch = chunks.slice(i, i + config.maxParallelAgents);
		const batchStart = i + 1;
		const batchEnd = Math.min(i + config.maxParallelAgents, chunks.length);

		progress.report({
			message: `Running sub-agents for chunks ${batchStart}-${batchEnd} of ${chunks.length}...`,
		});

		const promises = batch.map((chunk, idx) => {
			const chunkIdx = i + idx;
			const systemPrompt = getChunkPatternPrompt();
			const userMessage = buildChunkMessage(chunk);
			return runClaudeAnalysis(systemPrompt, userMessage, rootPath, progress, model, token)
				.then((result) => {
					if (result.success) {
						const chunkFile = path.join(patternsDir, `chunk-${String(chunkIdx + 1).padStart(3, '0')}.md`);
						const header = `# Chunk ${chunkIdx + 1}\n> Files: ${chunk.map(f => f.relativePath).join(', ')}\n\n`;
						fs.writeFileSync(chunkFile, header + result.output, 'utf-8');
					}
					return result;
				});
		});

		const results = await Promise.all(promises);

		if (token?.isCancellationRequested) { return null; }

		for (let j = 0; j < results.length; j++) {
			if (results[j].success) {
				chunkOutputs.push(results[j].output);
			} else if (!token?.isCancellationRequested) {
				const chunkIdx = i + j + 1;
				vscode.window.showWarningMessage(`Codelab: Chunk ${chunkIdx} failed — ${results[j].error}. Continuing with partial results.`);
			}
		}
	}

	if (chunkOutputs.length === 0) {
		if (!token?.isCancellationRequested) {
			vscode.window.showErrorMessage('All sub-agents failed. No patterns extracted.');
		}
		return null;
	}

	progress.report({ message: `Compiling ${chunkOutputs.length} chunk results into unified patterns...` });

	const compilerPrompt = getPatternCompilerPrompt();
	const compilerMessage = buildCompilerMessage(chunkOutputs);
	const compiled = await runClaudeAnalysis(compilerPrompt, compilerMessage, rootPath, progress, 'sonnet', token);

	if (!compiled.success) {
		if (!token?.isCancellationRequested) {
			vscode.window.showErrorMessage(`Pattern compilation failed: ${compiled.error}`);
		}
		return null;
	}

	return compiled.output;
}
