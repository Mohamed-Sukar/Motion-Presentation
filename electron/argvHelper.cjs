const fs = require('node:fs');
const path = require('node:path');

const PROJECT_EXTENSIONS = ['.mpres', '.mpres.json', '.json'];
const IGNORED_JSON_BASENAMES = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);

function isSupportedProjectFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const lower = filePath.trim().toLowerCase();
  const base = path.basename(lower);
  if (IGNORED_JSON_BASENAMES.has(base)) return false;
  return PROJECT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function extractProjectPathFromArgv(argv, options = {}) {
  if (!Array.isArray(argv)) return null;
  const existsSync = options.existsSync || fs.existsSync;
  const statSync = options.statSync || fs.statSync;
  const resolvedAppPath = options.appPath ? path.resolve(options.appPath) : null;

  const candidates = [];

  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/^["']|["']$/g, '');
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('-')) {
      continue;
    }

    const resolved = path.resolve(trimmed);
    if (resolvedAppPath && resolved === resolvedAppPath) {
      continue;
    }
    if (!isSupportedProjectFile(resolved)) {
      continue;
    }

    try {
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        candidates.push(resolved);
      }
    } catch {
      // Ignore unreadable paths
    }
  }

  if (candidates.length === 0) return null;

  // Prefer .mpres over .mpres.json over generic .json
  const mpresMatch = candidates.find((p) => p.toLowerCase().endsWith('.mpres'));
  if (mpresMatch) return mpresMatch;
  const legacyMpresMatch = candidates.find((p) => p.toLowerCase().endsWith('.mpres.json'));
  if (legacyMpresMatch) return legacyMpresMatch;
  return candidates[0];
}

module.exports = {
  isSupportedProjectFile,
  extractProjectPathFromArgv,
};
