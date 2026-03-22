import * as fs from 'fs';
import * as path from 'path';

export interface CodelabScope {
	mode: 'exclude' | 'include';
	patterns: string[];
}

const SCOPE_FILE = 'scope.json';

const DEFAULT_SCOPE: CodelabScope = {
	mode: 'exclude',
	patterns: [],
};

function ensureCodelabDir(rootPath: string): string {
	const dir = path.join(rootPath, '.codelab');
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	return dir;
}

export function loadScope(rootPath: string): CodelabScope {
	const filePath = path.join(rootPath, '.codelab', SCOPE_FILE);
	if (!fs.existsSync(filePath)) { return { ...DEFAULT_SCOPE, patterns: [] }; }

	try {
		const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		if ((data.mode !== 'exclude' && data.mode !== 'include') || !Array.isArray(data.patterns)) {
			return { ...DEFAULT_SCOPE, patterns: [] };
		}
		return data as CodelabScope;
	} catch {
		return { ...DEFAULT_SCOPE, patterns: [] };
	}
}

export function saveScope(rootPath: string, scope: CodelabScope): void {
	const dir = ensureCodelabDir(rootPath);
	fs.writeFileSync(path.join(dir, SCOPE_FILE), JSON.stringify(scope, null, 2), 'utf-8');
}


function matchPattern(relativePath: string, pattern: string): boolean {
	const normPath = relativePath.replace(/\\/g, '/');
	const normPattern = pattern.replace(/\\/g, '/').replace(/\/+$/, '');

	
	const regexStr = normPattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')  
		.replace(/\*\*/g, '\x00')              
		.replace(/\*/g, '[^/]*')               
		.replace(/\x00/g, '.*');               

	const regex = new RegExp(`^${regexStr}(/.*)?$`);
	return regex.test(normPath);
}


export function fileMatchesScope(relativePath: string, scope: CodelabScope): boolean {
	if (scope.patterns.length === 0) { return true; }
	const matched = scope.patterns.some(p => matchPattern(relativePath, p));
	return scope.mode === 'exclude' ? !matched : matched;
}

export function describeScopeMode(scope: CodelabScope): string {
	if (scope.patterns.length === 0) {
		return 'Analyzing all files (no scope filters set)';
	}
	if (scope.mode === 'exclude') {
		return `Excluding ${scope.patterns.length} pattern${scope.patterns.length === 1 ? '' : 's'} from analysis`;
	}
	return `Analyzing only ${scope.patterns.length} pattern${scope.patterns.length === 1 ? '' : 's'}`;
}
