import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConformanceIssue } from './conformanceChecker';

const CONFORMANCE_VERSION = 2;

export interface PersistedIssue extends ConformanceIssue {
	originalLineText: string;
	fileHash: string;
}

export interface PersistedConformance {
	version: number;
	timestamp: string;
	patternsHash: string;
	issues: PersistedIssue[];
}

export interface CodelabSettings {
	pushGuardEnabled: boolean;
	autoCheckOnSave: boolean;
	subAgentThreshold: number;
	deepAnalysisModel: string;
}

const DEFAULT_SETTINGS: CodelabSettings = {
	pushGuardEnabled: false,
	autoCheckOnSave: false,
	subAgentThreshold: 50,
	deepAnalysisModel: 'opus',
};

export function sha256(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function ensureCodelabDir(rootPath: string): string {
	const dir = path.join(rootPath, '.codelab');
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export function saveConformance(rootPath: string, issues: PersistedIssue[], patternsHash: string): void {
	const dir = ensureCodelabDir(rootPath);
	const data: PersistedConformance = {
		version: CONFORMANCE_VERSION,
		timestamp: new Date().toISOString(),
		patternsHash,
		issues,
	};
	fs.writeFileSync(path.join(dir, 'conformance.json'), JSON.stringify(data, null, 2), 'utf-8');
}

export function loadConformance(rootPath: string): PersistedConformance | null {
	const filePath = path.join(rootPath, '.codelab', 'conformance.json');
	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(raw) as PersistedConformance;
		if (!data.version || !data.issues || !Array.isArray(data.issues)) {
			return null;
		}
		return data;
	} catch {
		return null;
	}
}


export function validateConformance(rootPath: string, cached: PersistedConformance): PersistedIssue[] {
	const patternsPath = path.join(rootPath, '.codelab', 'patterns.md');
	if (!fs.existsSync(patternsPath)) {
		return [];
	}

	const currentPatternsHash = sha256(fs.readFileSync(patternsPath, 'utf-8'));
	if (currentPatternsHash !== cached.patternsHash) {
		return []; // Patterns changed → discard all
	}

	const validIssues: PersistedIssue[] = [];
	const fileHashCache = new Map<string, string>();

	for (const issue of cached.issues) {
		const fullPath = path.join(rootPath, issue.file);
		if (!fs.existsSync(fullPath)) {
			continue;
		}

		let currentHash = fileHashCache.get(issue.file);
		if (currentHash === undefined) {
			currentHash = sha256(fs.readFileSync(fullPath, 'utf-8'));
			fileHashCache.set(issue.file, currentHash);
		}

		if (currentHash === issue.fileHash) {
			validIssues.push(issue);
		}
	}

	return validIssues;
}


export function saveSettings(rootPath: string, settings: CodelabSettings): void {
	const dir = ensureCodelabDir(rootPath);
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}

export function loadSettings(rootPath: string): CodelabSettings {
	const filePath = path.join(rootPath, '.codelab', 'settings.json');
	if (!fs.existsSync(filePath)) {
		return { ...DEFAULT_SETTINGS };
	}

	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(raw);
		return { ...DEFAULT_SETTINGS, ...data };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
