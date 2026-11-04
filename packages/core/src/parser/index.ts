import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import { toString as mdastToString } from 'mdast-util-to-string';
import YAML from 'yaml';
import type { Content, Heading, List, ListItem, Paragraph, Root } from 'mdast';
import type {
  ContextNote,
  DirectiveNode,
  HarnessFile,
  HarnessFormat,
  HarnessFrontmatter,
  ImperativeModality,
  ImportRef,
  RuleSection,
} from '../types.js';
import { normalizeGlobList, resolveAgentProfiles, resolveEffectiveScope, toPosixPath } from '../scope/index.js';

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Fast deterministic token estimation (~4 chars/token or word-piece boundary count)
  const tokens = text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g);
  return tokens ? tokens.length : Math.ceil(text.length / 4);
}

export function extractYamlFrontmatter(rawContent: string): {
  frontmatter?: HarnessFrontmatter;
  frontmatterLineCount: number;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rawContent);
  if (!match) {
    return { frontmatterLineCount: 0 };
  }
  const yamlBlock = match[1];
  const frontmatterLineCount = match[0].split(/\r?\n/).length - 1;
  try {
    const parsed = YAML.parse(yamlBlock) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { frontmatterLineCount };
    }
    const paths = normalizeGlobList(parsed.paths);
    const globs = normalizeGlobList(parsed.globs);
    const applyTo = normalizeGlobList(parsed.applyTo);
    const alwaysApply = typeof parsed.alwaysApply === 'boolean' ? parsed.alwaysApply : undefined;
    const description = typeof parsed.description === 'string' ? parsed.description : undefined;

    return {
      frontmatter: {
        paths: paths.length > 0 ? paths : undefined,
        globs: globs.length > 0 ? globs : undefined,
        applyTo: applyTo.length > 0 ? applyTo : undefined,
        alwaysApply,
        description,
        raw: parsed,
      },
      frontmatterLineCount,
    };
  } catch {
    return { frontmatterLineCount };
  }
}

interface PragmaMap {
  fileSuppressedCodes: Set<string>;
  fileOverrideGlobs: Set<string>;
  lineSuppressedCodes: Map<number, Set<string>>;
  lineOverrideGlobs: Map<number, Set<string>>;
  syncMarkersByLine: Map<number, { id: string; globs: string[] }>;
}

const ALL_DIAGNOSTIC_CODES = [
  'CTX001',
  'CTX002',
  'CTX003',
  'CTX004',
  'CTX005',
  'CTX006',
  'CTX007',
  'CTX008',
  'CTX009',
];

function extractPragmas(rawContent: string): PragmaMap {
  const lines = rawContent.split(/\r?\n/);
  const fileSuppressedCodes = new Set<string>();
  const fileOverrideGlobs = new Set<string>();
  const lineSuppressedCodes = new Map<number, Set<string>>();
  const lineOverrideGlobs = new Map<number, Set<string>>();
  const syncMarkersByLine = new Map<number, { id: string; globs: string[] }>();

  const addLineSuppression = (lineNum: number, codes: string[]) => {
    const existing = lineSuppressedCodes.get(lineNum) ?? new Set<string>();
    for (const c of codes) existing.add(c);
    lineSuppressedCodes.set(lineNum, existing);
  };

  const addLineOverride = (lineNum: number, globs: string[]) => {
    const existing = lineOverrideGlobs.get(lineNum) ?? new Set<string>();
    for (const g of globs) existing.add(g);
    lineOverrideGlobs.set(lineNum, existing);
  };

  let seenNonCommentLine = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Check deontic-ignore
    const ignoreRegex = /<!--\s*deontic-ignore(?:-next-line|-file)?(?:\s*:?\s*([\s\S]*?))?-->/gi;
    let m: RegExpExecArray | null;
    while ((m = ignoreRegex.exec(line)) !== null) {
      const fullTag = m[0];
      const rawCodes = (m[1] ?? '').trim();
      const parsedCodes = rawCodes
        ? rawCodes
            .split(/[,\s]+/)
            .map((s) => s.trim().toUpperCase())
            .filter((s) => /^CTX\d{3}$/.test(s))
        : ALL_DIAGNOSTIC_CODES;
      const codes = parsedCodes.length > 0 ? parsedCodes : ALL_DIAGNOSTIC_CODES;

      const isFileLevel =
        fullTag.toLowerCase().includes('deontic-ignore-file') ||
        (!seenNonCommentLine && line.trim() === fullTag.trim());

      if (isFileLevel && fullTag.toLowerCase().includes('deontic-ignore-file')) {
        for (const c of codes) fileSuppressedCodes.add(c);
      }
      // Apply to current line and next non-empty line(s)
      addLineSuppression(lineNum, codes);
      addLineSuppression(lineNum + 1, codes);
      if (i + 1 < lines.length && lines[i + 1].trim() === '') {
        addLineSuppression(lineNum + 2, codes);
      }
    }

    // Check deontic-override
    const overrideRegex = /<!--\s*deontic-override(?:\s*:\s*([\s\S]*?))?-->/gi;
    while ((m = overrideRegex.exec(line)) !== null) {
      const rawGlobs = (m[1] ?? '').trim();
      const globs = rawGlobs
        ? rawGlobs
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : ['**/*'];
      for (const g of globs) fileOverrideGlobs.add(g);
      addLineOverride(lineNum, globs);
      addLineOverride(lineNum + 1, globs);
      if (i + 1 < lines.length && lines[i + 1].trim() === '') {
        addLineOverride(lineNum + 2, globs);
      }
    }

    // Check deontic:sync marker
    const syncRegex = /<!--\s*deontic:sync\s+id="([^"]+)"\s+globs="([^"]+)"\s*-->/i;
    const syncMatch = syncRegex.exec(line);
    if (syncMatch) {
      const id = syncMatch[1];
      const globs = syncMatch[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      syncMarkersByLine.set(lineNum, { id, globs });
    }

    const stripped = line.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (stripped.length > 0 && !stripped.startsWith('---')) {
      seenNonCommentLine = true;
    }
  }

  return {
    fileSuppressedCodes,
    fileOverrideGlobs,
    lineSuppressedCodes,
    lineOverrideGlobs,
    syncMarkersByLine,
  };
}

const COMMAND_PREFIX_REGEX =
  /^(?:pnpm|npm|yarn|bun|npx|make|cargo|just|turbo|nx)\s+[A-Za-z0-9_:./-]+(?:\s+[A-Za-z0-9_:./-]+)*/;

export function extractReferencedCommands(rawText: string): string[] {
  const commands = new Set<string>();
  const codeSpanRegex = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpanRegex.exec(rawText)) !== null) {
    const inner = m[1].trim();
    const cmdMatch = COMMAND_PREFIX_REGEX.exec(inner);
    if (cmdMatch) {
      commands.add(cmdMatch[0].trim());
    }
  }
  return Array.from(commands);
}

const KNOWN_FILE_EXT_REGEX =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|yml|yaml|toml|sh|bash|zsh|py|go|rs|sql|prisma|graphql|css|scss|html|vue|svelte|astro|lock|env|txt)$/i;

export function looksLikeFilePath(candidate: string): boolean {
  const cleaned = candidate.trim().replace(/^[`'"]+|[`'",.:;!?)]+$/g, '');
  if (!cleaned || cleaned.length < 2) return false;
  if (cleaned.includes(' ') || cleaned.includes('\n')) return false;
  if (/^[a-zA-Z]+:\/\//.test(cleaned) || cleaned.startsWith('mailto:')) return false;
  // Exclude commands
  if (/^(?:pnpm|npm|yarn|bun|npx|make|cargo|git)\b/.test(cleaned)) return false;

  if (cleaned.includes('/')) {
    return true;
  }
  if (KNOWN_FILE_EXT_REGEX.test(cleaned)) {
    return true;
  }
  return false;
}

export function extractReferencedPaths(rawText: string): string[] {
  const paths = new Set<string>();

  // 1. Inline code spans `...`
  const codeSpanRegex = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpanRegex.exec(rawText)) !== null) {
    const inner = m[1].trim();
    if (looksLikeFilePath(inner)) {
      paths.add(inner.replace(/^\.\//, ''));
    }
  }

  // 2. Markdown links [label](target)
  const linkRegex = /\[[^\]]*\]\(([^)\s]+)\)/g;
  while ((m = linkRegex.exec(rawText)) !== null) {
    const target = m[1].trim().split('#')[0];
    if (target && !/^[a-zA-Z]+:\/\//.test(target) && !target.startsWith('mailto:') && looksLikeFilePath(target)) {
      paths.add(target.replace(/^\.\//, ''));
    }
  }

  // 3. Bare paths outside code spans (e.g. packages/api/src/db.ts or src/auth/index.ts)
  const withoutCode = rawText.replace(/`[^`\n]+`/g, ' ').replace(/\[[^\]]*\]\([^)]+\)/g, ' ');
  const barePathRegex = /(?:^|\s|\()((?:\.\/|\.\.\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./[\]{}<>*$-]+)(?=$|\s|[),.:;!?])/g;
  while ((m = barePathRegex.exec(withoutCode)) !== null) {
    const candidate = m[1].replace(/[.,:;!?)]+$/, '');
    if ( !candidate.startsWith('@') && looksLikeFilePath(candidate)) {
      paths.add(candidate.replace(/^\.\//, ''));
    }
  }

  return Array.from(paths);
}

export function extractImportsFromLines(
  relFilePath: string,
  rawContent: string,
  pragmas: PragmaMap,
  frontmatterLineCount: number,
): ImportRef[] {
  const imports: ImportRef[] = [];
  const lines = rawContent.split(/\r?\n/);
  let inCodeFence = false;

  for (let i = Math.max(0, frontmatterLineCount); i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (/^\s*<!--/.test(line)) continue;

    // Mask out inline code spans with spaces of equal length so column indices stay exact!
    const maskedLine = line.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));

    // Match @path/to/file imports
    const importRegex = /(?:^|(?<=[\s(]))(@(?:~\/|\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+|\.[A-Za-z0-9_-]+))/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(maskedLine)) !== null) {
      const rawImport = m[1].replace(/[.,:;!?)]+$/, '');
      if (rawImport.startsWith('@~/')) {
        // Home directory import outside repo, skip
        continue;
      }
      const colStart = m.index + 1;
      const colEnd = colStart + rawImport.length;
      const importBody = rawImport.slice(1); // strip leading '@'

      let targetPath: string;
      if (importBody.startsWith('./') || importBody.startsWith('../')) {
        const dir = path.posix.dirname(toPosixPath(relFilePath));
        targetPath = path.posix.normalize(path.posix.join(dir, importBody));
      } else {
        targetPath = toPosixPath(importBody);
      }

      const suppressed = new Set<string>([
        ...pragmas.fileSuppressedCodes,
        ...(pragmas.lineSuppressedCodes.get(lineNum) ?? []),
      ]);

      imports.push({
        rawImport,
        targetPath,
        sourceFile: relFilePath,
        lineStart: lineNum,
        lineEnd: lineNum,
        columnStart: colStart,
        columnEnd: colEnd,
        suppressedCodes: Array.from(suppressed),
      });
    }
  }

  return imports;
}

const IMPERATIVE_START_VERBS = new Set([
  'use',
  'run',
  'write',
  'keep',
  'place',
  'import',
  'export',
  'validate',
  'ensure',
  'follow',
  'mock',
  'test',
  'format',
  'lint',
  'build',
  'compile',
  'configure',
  'define',
  'return',
  'throw',
  'handle',
  'pass',
  'call',
  'include',
  'exclude',
  'commit',
  'push',
  'merge',
  'rebase',
  'verify',
  'check',
  'Enforce',
  'enforce',
  'wrap',
  'store',
  'locate',
  'create',
  'update',
  'delete',
  'remove',
  'add',
  'set',
  'make',
  'declare',
  'specify',
]);

export function classifyClauseModality(clauseText: string): ImperativeModality | null {
  const cleaned = clauseText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim();

  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();

  // Check MUST_NOT patterns first
  if (
    /\b(?:must\s+not|mustn't|never|do\s+not|don't|forbid|forbidden|prohibited|disallow|disallowed|ban|banned)\b/.test(
      lower,
    ) ||
    /\bzero\s+[a-z0-9_-]+\s+dependencies\b/.test(lower) ||
    /^no\s+[a-z0-9_-]+/i.test(lower)
  ) {
    return 'MUST_NOT';
  }

  // Check SHOULD_NOT patterns
  if (/\b(?:should\s+not|shouldn't|avoid|discouraged|do\s+not\s+prefer|prefer\s+not\s+to)\b/.test(lower)) {
    return 'SHOULD_NOT';
  }

  // Check SHOULD patterns
  if (/\b(?:should|prefer|recommended|ideally|favor|encourage|encouraged)\b/.test(lower)) {
    return 'SHOULD';
  }

  // Check explicit MUST patterns
  if (/\b(?:must|always|required|require|mandatory|exclusively\s+use|only\s+use)\b/.test(lower)) {
    return 'MUST';
  }

  // Check imperative verb at start of clause
  const firstWord = lower.split(/[\s,.:;]+/)[0];
  if (firstWord && IMPERATIVE_START_VERBS.has(firstWord)) {
    return 'MUST';
  }

  return null;
}

export function inferSimpleTopicAndPredicate(
  clauseText: string,
  modality: ImperativeModality,
): {
  topic: string;
  predicate: { action: string; target: string; condition?: string };
} {
  const cleaned = clauseText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/[`*_]/g, '')
    .trim();
  const lower = cleaned.toLowerCase();

  let condition: string | undefined;
  const condMatch = /\b(?:when|if|unless|in|for)\s+([^.,;]+)$/i.exec(cleaned);
  if (condMatch) {
    condition = condMatch[1].trim().toLowerCase();
  }

  if (/\b(?:pnpm|npm|yarn|bun)\b/.test(lower)) {
    const pkg = /\b(pnpm|npm|yarn|bun)\b/.exec(lower)![1];
    return {
      topic: 'package_manager',
      predicate: { action: 'use', target: pkg, condition },
    };
  }

  if (/\b(?:vitest|jest|mocha|playwright|cypress)\b/.test(lower)) {
    const runner = /\b(vitest|jest|mocha|playwright|cypress)\b/.exec(lower)![1];
    return {
      topic: 'test_runner',
      predicate: { action: 'use', target: runner, condition },
    };
  }

  if (/\b(?:prisma|drizzle|typeorm|knex|database|db|sql|testcontainers|docker)\b/.test(lower)) {
    const target = /\b(prisma|drizzle|typeorm|knex|database|db|sql|testcontainers|docker)\b/.exec(lower)![1];
    const action = /\bmock(?:ing)?\b/.test(lower) ? 'mock' : 'use';
    return {
      topic: 'db_mocking',
      predicate: { action, target: target === 'db' ? 'database' : target, condition },
    };
  }

  if (/\b(?:default\s+exports?|named\s+exports?)\b/.test(lower)) {
    const isDefault = /\bdefault\s+exports?\b/.test(lower);
    return {
      topic: 'export_style',
      predicate: { action: 'use', target: isDefault ? 'default_export' : 'named_export', condition },
    };
  }

  // Generic fallback
  const words = lower
    .replace(/[^a-z0-9_./\s-]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 1 &&
        ![
          'must',
          'not',
          'never',
          'always',
          'should',
          'prefer',
          'avoid',
          'do',
          'dont',
          'the',
          'all',
          'for',
          'in',
          'to',
          'of',
          'and',
          'or',
          'with',
        ].includes(w),
    );

  const action = words[0] ?? (modality.endsWith('NOT') ? 'forbid' : 'require');
  const target = words.slice(1, 4).join('_') || action;
  return {
    topic: 'general',
    predicate: { action, target, condition },
  };
}

export interface DecomposedClause {
  text: string;
  modality: ImperativeModality;
}

export function decomposeSentenceIntoDirectives(sentenceText: string): DecomposedClause[] {
  const cleaned = sentenceText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();

  if (!cleaned) return [];

  // Step 1: Split on semicolons first
  const semiParts = cleaned
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (semiParts.length > 1) {
    const out: DecomposedClause[] = [];
    for (const part of semiParts) {
      out.push(...decomposeSentenceIntoDirectives(part));
    }
    return out;
  }

  // Step 2: Check "instead of" / "rather than" / "over" contrastive pattern
  // e.g. "Use pnpm instead of npm for all workspace installs."
  // e.g. "Always use vitest rather than jest."
  // e.g. "Prefer named exports over default exports."
  const insteadMatch = /^([\s\S]+?)\s+\b(?:instead\s+of|rather\s+than)\s+([\s\S]+)$/i.exec(cleaned);
  if (insteadMatch) {
    const leftRaw = insteadMatch[1].trim();
    const rightRaw = insteadMatch[2].trim();
    const leftModality = classifyClauseModality(leftRaw) ?? 'MUST';
    const rightModality: ImperativeModality =
      leftModality === 'SHOULD' || leftModality === 'SHOULD_NOT' ? 'SHOULD_NOT' : 'MUST_NOT';

    // Strip trailing context ("for all workspace installs") from rightRaw if present so right clause focuses on target
    return [
      { text: leftRaw, modality: leftModality },
      { text: `Do not use ${rightRaw}`, modality: rightModality },
    ];
  }

  // Step 3: Check "Never X, always Y" or "Do not X, use Y" or "Always X, never Y" comma-joined contrasting imperatives
  const commaContrastMatch =
    /^((?:never|do\s+not|don't|must\s+not|always|must)\s+[^,]+),\s*((?:always|never|do\s+not|don't|must|use|prefer|avoid)\s+[\s\S]+)$/i.exec(
      cleaned,
    );
  if (commaContrastMatch) {
    const leftPart = commaContrastMatch[1].trim();
    const rightPart = commaContrastMatch[2].trim();
    const leftDecomp = decomposeSentenceIntoDirectives(leftPart);
    const rightDecomp = decomposeSentenceIntoDirectives(rightPart);
    if (leftDecomp.length > 0 && rightDecomp.length > 0) {
      return [...leftDecomp, ...rightDecomp];
    }
  }

  const modality = classifyClauseModality(cleaned);
  if (!modality) return [];

  return [{ text: cleaned, modality }];
}

const DEPRECATION_KEYWORDS_REGEX = /\b(?:deleted|removed|deprecated|legacy|formerly|obsolete|historical)\b/i;

const ASCII_TREE_LINE_REGEX = /(?:├──|└──|│\s+|\+--|\|--)/;

export function isAsciiDirectoryTree(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.length < 8) return false;
  let treeLines = 0;
  for (const line of lines) {
    if (ASCII_TREE_LINE_REGEX.test(line)) {
      treeLines++;
    }
  }
  return treeLines >= 4;
}

export function parseHarnessFile(
  relPath: string,
  absPath: string,
  format: HarnessFormat,
  rawContent: string,
): HarnessFile {
  const posixPath = toPosixPath(relPath);
  const byteSize = Buffer.byteLength(rawContent, 'utf8');
  const tokenCount = estimateTokenCount(rawContent);
  const agentProfiles = resolveAgentProfiles(posixPath, format);

  if (format === 'mcp-config' || format === 'claude-settings') {
    const { effectiveGlobs, isAlwaysLoadedAtRoot } = resolveEffectiveScope(posixPath, format, undefined);
    return {
      path: posixPath,
      absolutePath: absPath,
      format,
      agentProfiles,
      rawContent,
      byteSize,
      tokenCount,
      effectiveGlobs,
      isAlwaysLoadedAtRoot,
      sections: [],
      directives: [],
      contextNotes: [],
      imports: [],
      suppressedCodes: [],
      overrideGlobs: [],
    };
  }

  const { frontmatter, frontmatterLineCount } = extractYamlFrontmatter(rawContent);
  const { effectiveGlobs, isAlwaysLoadedAtRoot } = resolveEffectiveScope(posixPath, format, frontmatter);
  const pragmas = extractPragmas(rawContent);
  const lines = rawContent.split(/\r?\n/);

  const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);
  const tree = processor.parse(rawContent) as Root;

  const sections: RuleSection[] = [];
  const allDirectives: DirectiveNode[] = [];
  const allContextNotes: ContextNote[] = [];

  let currentSection: RuleSection | null = null;
  let sectionIndex = 0;
  let directiveIndex = 0;
  let noteIndex = 0;
  let pendingSyncMarker: { id: string; globs: string[] } | undefined;

  const startNewSection = (
    headingText: string,
    headingLevel: number,
    lineStart: number,
    colStart: number,
    lineEnd: number,
    colEnd: number,
    syncMarker?: { id: string; globs: string[] },
  ): RuleSection => {
    sectionIndex++;
    const secGlobs = syncMarker && syncMarker.globs.length > 0 ? syncMarker.globs : effectiveGlobs;
    const secAlwaysRoot = syncMarker && syncMarker.globs.length > 0 ? false : isAlwaysLoadedAtRoot;
    const sec: RuleSection = {
      id: `${posixPath}#section-${sectionIndex}`,
      sourceFile: posixPath,
      heading: headingText,
      headingLevel,
      lineStart,
      lineEnd,
      columnStart: colStart,
      columnEnd: colEnd,
      rawContent: '',
      effectiveGlobs: secGlobs,
      isAlwaysLoadedAtRoot: secAlwaysRoot,
      directives: [],
      contextNotes: [],
      referencedPaths: [],
      referencedCommands: [],
      suppressedCodes: Array.from(pragmas.fileSuppressedCodes),
      overrideGlobs: Array.from(pragmas.fileOverrideGlobs),
      syncMarker,
    };
    sections.push(sec);
    return sec;
  };

  const processStatementNode = (node: Content, section: RuleSection) => {
    const pos = node.position;
    if (!pos) return;

    const lineStart = pos.start.line;
    const lineEnd = pos.end.line;
    const colStart = pos.start.column;
    const colEnd = pos.end.column;

    section.lineEnd = Math.max(section.lineEnd, lineEnd);
    section.columnEnd = colEnd;

    const rawSlice = lines.slice(lineStart - 1, lineEnd).join('\n');

    const suppressed = new Set<string>([
      ...pragmas.fileSuppressedCodes,
      ...section.suppressedCodes,
    ]);
    const overrides = new Set<string>([
      ...pragmas.fileOverrideGlobs,
      ...section.overrideGlobs,
    ]);
    for (let ln = lineStart; ln <= lineEnd; ln++) {
      for (const c of pragmas.lineSuppressedCodes.get(ln) ?? []) suppressed.add(c);
      for (const g of pragmas.lineOverrideGlobs.get(ln) ?? []) overrides.add(g);
    }

    const referencedPaths = extractReferencedPaths(rawSlice);
    const referencedCommands = extractReferencedCommands(rawSlice);

    for (const p of referencedPaths) {
      if (!section.referencedPaths.includes(p)) section.referencedPaths.push(p);
    }
    for (const c of referencedCommands) {
      if (!section.referencedCommands.includes(c)) section.referencedCommands.push(c);
    }

    if (node.type === 'code') {
      const isTree = isAsciiDirectoryTree(node.value);
      noteIndex++;
      const note: ContextNote = {
        id: `${posixPath}#note-${noteIndex}`,
        sourceFile: posixPath,
        sectionId: section.id,
        lineStart,
        lineEnd,
        columnStart: colStart,
        columnEnd: colEnd,
        rawText: rawSlice,
        referencedPaths,
        referencedCommands,
        isDerivableDirectoryTree: isTree,
        treeKind: isTree ? 'ascii-tree' : undefined,
        suppressedCodes: Array.from(suppressed),
      };
      section.contextNotes.push(note);
      allContextNotes.push(note);
      return;
    }

    const textContent = rawSlice.trim();
    if (!textContent || /^<!--[\s\S]*-->$/.test(textContent)) {
      return;
    }

    // Check if paragraph is an ASCII tree
    if (node.type === 'paragraph' && isAsciiDirectoryTree(rawSlice)) {
      noteIndex++;
      const note: ContextNote = {
        id: `${posixPath}#note-${noteIndex}`,
        sourceFile: posixPath,
        sectionId: section.id,
        lineStart,
        lineEnd,
        columnStart: colStart,
        columnEnd: colEnd,
        rawText: rawSlice,
        referencedPaths,
        referencedCommands,
        isDerivableDirectoryTree: true,
        treeKind: 'ascii-tree',
        suppressedCodes: Array.from(suppressed),
      };
      section.contextNotes.push(note);
      allContextNotes.push(note);
      return;
    }

    const clauses = decomposeSentenceIntoDirectives(rawSlice);
    if (clauses.length === 0) {
      noteIndex++;
      const note: ContextNote = {
        id: `${posixPath}#note-${noteIndex}`,
        sourceFile: posixPath,
        sectionId: section.id,
        lineStart,
        lineEnd,
        columnStart: colStart,
        columnEnd: colEnd,
        rawText: rawSlice,
        referencedPaths,
        referencedCommands,
        suppressedCodes: Array.from(suppressed),
      };
      section.contextNotes.push(note);
      allContextNotes.push(note);
      return;
    }

    const isDeprecatedContext = DEPRECATION_KEYWORDS_REGEX.test(rawSlice);

    for (const clause of clauses) {
      directiveIndex++;
      const { topic, predicate } = inferSimpleTopicAndPredicate(clause.text, clause.modality);
      const clausePaths = extractReferencedPaths(clause.text);
      const clauseCommands = extractReferencedCommands(clause.text);

      // Combine with sentence-level paths/commands so shared context on the same line is preserved
      const mergedPaths = Array.from(new Set([...clausePaths, ...referencedPaths]));
      const mergedCommands = Array.from(new Set([...clauseCommands, ...referencedCommands]));

      const directive: DirectiveNode = {
        id: `${posixPath}#directive-${directiveIndex}`,
        sourceFile: posixPath,
        sectionId: section.id,
        lineStart,
        lineEnd,
        columnStart: colStart,
        columnEnd: colEnd,
        rawText: clause.text,
        effectiveGlobs: [...section.effectiveGlobs],
        isAlwaysLoadedAtRoot: section.isAlwaysLoadedAtRoot,
        modality: clause.modality,
        topic,
        predicate,
        referencedPaths: mergedPaths,
        referencedCommands: mergedCommands,
        suppressedCodes: Array.from(suppressed),
        overrideGlobs: Array.from(overrides),
        deprecatedContext: isDeprecatedContext,
      };
      section.directives.push(directive);
      allDirectives.push(directive);
    }
  };

  for (const child of tree.children) {
    if (child.type === 'yaml') {
      continue;
    }

    const pos = child.position;
    if (!pos) continue;

    if (child.type === 'html') {
      const syncMarker = pragmas.syncMarkersByLine.get(pos.start.line);
      if (syncMarker) {
        pendingSyncMarker = syncMarker;
      }
      continue;
    }

    if (child.type === 'heading') {
      const headingNode = child as Heading;
      const headingText = mdastToString(headingNode).trim();
      const marker =
        pendingSyncMarker ??
        pragmas.syncMarkersByLine.get(pos.start.line - 1) ??
        pragmas.syncMarkersByLine.get(pos.start.line);
      pendingSyncMarker = undefined;

      currentSection = startNewSection(
        headingText,
        headingNode.depth,
        pos.start.line,
        pos.start.column,
        pos.end.line,
        pos.end.column,
        marker,
      );
      // Propagate any pragmas on the heading line to the entire section
      for (const c of pragmas.lineSuppressedCodes.get(pos.start.line) ?? []) {
        if (!currentSection.suppressedCodes.includes(c)) currentSection.suppressedCodes.push(c);
      }
      for (const g of pragmas.lineOverrideGlobs.get(pos.start.line) ?? []) {
        if (!currentSection.overrideGlobs.includes(g)) currentSection.overrideGlobs.push(g);
      }
      continue;
    }

    if (!currentSection) {
      currentSection = startNewSection(
        '(Root)',
        0,
        pos.start.line,
        pos.start.column,
        pos.end.line,
        pos.end.column,
        pendingSyncMarker,
      );
      pendingSyncMarker = undefined;
    }

    if (child.type === 'list') {
      const listNode = child as List;
      const items = listNode.children as ListItem[];
      const directivesBeforeList = currentSection.directives.length;
      const notesBeforeList = currentSection.contextNotes.length;

      for (const item of items) {
        processStatementNode(item as unknown as Content, currentSection);
      }

      // Check if this list is a Derivable Directory Tree (path-catalog list >= 10 items, >= 70% start with path, 0 directives)
      const listDirectivesCount = currentSection.directives.length - directivesBeforeList;
      const listNotes = currentSection.contextNotes.slice(notesBeforeList);
      if (items.length >= 10 && listDirectivesCount === 0 && listNotes.length >= 10) {
        const pathStarterCount = listNotes.filter((n) => n.referencedPaths.length > 0).length;
        if (pathStarterCount / listNotes.length >= 0.7) {
          for (const n of listNotes) {
            n.isDerivableDirectoryTree = true;
            n.treeKind = 'path-catalog';
          }
        }
      }
    } else if (child.type === 'paragraph') {
      const para = child as Paragraph;
      const pPos = para.position!;
      // If a paragraph has multiple lines that are separate sentences/rules, process each line if multi-line
      if (pPos.end.line > pPos.start.line && !isAsciiDirectoryTree(lines.slice(pPos.start.line - 1, pPos.end.line).join('\n'))) {
        for (let ln = pPos.start.line; ln <= pPos.end.line; ln++) {
          const lineText = lines[ln - 1];
          if (!lineText.trim()) continue;
          const syntheticNode: Content = {
            type: 'paragraph',
            children: [{ type: 'text', value: lineText }],
            position: {
              start: { line: ln, column: 1 },
              end: { line: ln, column: lineText.length + 1 },
            },
          };
          processStatementNode(syntheticNode, currentSection);
        }
      } else {
        processStatementNode(child, currentSection);
      }
    } else {
      processStatementNode(child, currentSection);
    }
  }

  // Finalize section rawContent
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const nextSec = sections[i + 1];
    if (nextSec) {
      sec.lineEnd = Math.max(sec.lineStart, nextSec.lineStart - 1);
      // Trim trailing blank lines from section range
      while (sec.lineEnd > sec.lineStart && lines[sec.lineEnd - 1]?.trim() === '') {
        sec.lineEnd--;
      }
    } else {
      sec.lineEnd = Math.max(sec.lineEnd, lines.length);
      while (sec.lineEnd > sec.lineStart && lines[sec.lineEnd - 1]?.trim() === '') {
        sec.lineEnd--;
      }
    }
    sec.rawContent = lines.slice(sec.lineStart - 1, sec.lineEnd).join('\n');
    sec.columnEnd = (lines[sec.lineEnd - 1]?.length ?? 0) + 1;
  }

  const imports = extractImportsFromLines(posixPath, rawContent, pragmas, frontmatterLineCount);

  return {
    path: posixPath,
    absolutePath: absPath,
    format,
    agentProfiles,
    rawContent,
    byteSize,
    tokenCount,
    frontmatter,
    effectiveGlobs,
    isAlwaysLoadedAtRoot,
    sections,
    directives: allDirectives,
    contextNotes: allContextNotes,
    imports,
    suppressedCodes: Array.from(pragmas.fileSuppressedCodes),
    overrideGlobs: Array.from(pragmas.fileOverrideGlobs),
  };
}
