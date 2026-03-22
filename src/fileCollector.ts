import * as fs from 'fs';
import * as path from 'path';
import { CodelabScope, fileMatchesScope } from './scopeManager';

const IGNORED_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.venv', 'venv',
	'dist', 'build', '.next', '.nuxt', 'coverage', '.cache',
	'.codelab',
]);

const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
	'.mp3', '.mp4', '.avi', '.mov', '.webm',
	'.exe', '.dll', '.so', '.dylib',
	'.pyc', '.pyo', '.class',
	'.lock',
]);

const IGNORED_FILES = new Set([
	'.DS_Store', 'Thumbs.db', 'desktop.ini', '.env'
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export interface CollectedFile {
	relativePath: string;
	content: string;
}

export function parseGitignore(workspaceRoot: string): Set<string> {
	const gitignorePath = path.join(workspaceRoot, '.gitignore');
	const patterns = new Set<string>();

	try {
		const content = fs.readFileSync(gitignorePath, 'utf-8');
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith('#')) {
				patterns.add(trimmed.replace(/\/+$/, ''));
			}
		}
	} catch {
		// No .gitignore — that's fine
	}

	return patterns;
}

function shouldIgnore(name: string, gitignorePatterns: Set<string>): boolean {
	return IGNORED_DIRS.has(name) || gitignorePatterns.has(name);
}

function isBinary(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkDir(
	dir: string,
	rootPath: string,
	gitignorePatterns: Set<string>,
	files: CollectedFile[]
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (shouldIgnore(entry.name, gitignorePatterns)) {
			continue;
		}

		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			walkDir(fullPath, rootPath, gitignorePatterns, files);
		} else if (entry.isFile()) {
			if (IGNORED_FILES.has(entry.name) || isBinary(fullPath)) {
				continue;
			}

			let stat: fs.Stats;
			try {
				stat = fs.statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.size > MAX_FILE_SIZE) {
				continue;
			}

			try {
				const content = fs.readFileSync(fullPath, 'utf-8');
				if (content.includes('\0')) {
					continue;
				}
				const relativePath = path.relative(rootPath, fullPath);
				files.push({ relativePath, content });
			} catch {
			}
		}
	}
}

export function collectFiles(rootPath: string, scope?: CodelabScope): CollectedFile[] {
	const gitignorePatterns = parseGitignore(rootPath);
	const files: CollectedFile[] = [];
	walkDir(rootPath, rootPath, gitignorePatterns, files);
	if (!scope || scope.patterns.length === 0) { return files; }
	return files.filter(f => fileMatchesScope(f.relativePath, scope));
}

export function countFiles(rootPath: string, scope?: CodelabScope): number {
	return collectFiles(rootPath, scope).length;
}
