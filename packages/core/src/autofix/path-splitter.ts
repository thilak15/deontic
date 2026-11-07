import fs from 'node:fs';
import path from 'node:path';
import type {
  ProposedSplitFile,
  RuleSection,
  SplitWorkspaceOptions,
  SplitWorkspaceResult,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { estimateTokenCount } from '../parser/index.js';
import { toPosixPath } from '../scope/index.js';

const ROOT_CONFIG_OR_HARNESS_FILES = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'gemini.md',
  'readme.md',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  '.gitignore',
  'makefile',
  'deontic.json',
  '.mcp.json',
  'mcp.json',
  '.cursorrules',
  '.windsurfrules',
]);

const GENERIC_DIR_SEGMENTS = new Set([
  'src',
  'lib',
  'pkg',
  'packages',
  'apps',
  'dist',
  'build',
  'out',
  'docs',
  'types',
  'utils',
  'common',
  'shared',
  'core',
  'config',
  'scripts',
  'public',
  'assets',
  '.claude',
  '.cursor',
  '.github',
  '.vscode',
]);

const GLOBAL_HEADING_PATTERNS = [
  /^\(root\)$/i,
  /\b(?:overview|project\s+overview|repository\s+guidelines|general\s+rules|general|core\s+principles)\b/i,
  /\b(?:package\s+manage(?:ment|r)|dependencies|workspace\s+installs)\b/i,
  /\b(?:git\s+workflow|version\s+control|commits?|pull\s+requests?|branch(?:ing)?)\b/i,
  /\b(?:code\s+style|coding\s+standards|style\s+guide|formatting|linting|conventions)\b/i,
  /\b(?:getting\s+started|setup|environment|development\s+workflow|tooling)\b/i,
];

const DOMAIN_HEADING_KEYWORDS =
  /\b(?:prisma|drizzle|typeorm|knex|database|databases|db|sql|migrations?|playwright|cypress|e2e|end-to-end|react|components?|frontend|ui|tsx|jsx|tailwind|shadcn|graphql|trpc|webhooks?|billing|payments?|stripe|auth|authentication|authorization|oauth|jwt|rbac|docker|kubernetes|k8s|terraform)\b/i;

interface OntologyDomainRule {
  id: string;
  keywordRegex: RegExp;
  dirSegments: string[];
  extensions: string[];
  defaultGlobs: (text: string, repoDirs: string[], repoFiles: string[]) => string[];
}

const ONTOLOGY_DOMAIN_RULES: OntologyDomainRule[] = [
  {
    id: 'database',
    keywordRegex:
      /\b(?:prisma|drizzle|typeorm|knex|database|databases|db|sql|migrations?|schema\.prisma|postgres|postgresql|sqlite|testcontainers)\b/i,
    dirSegments: ['prisma', 'db', 'database', 'migrations', 'drizzle', 'sql'],
    extensions: ['.prisma', '.sql'],
    defaultGlobs: (text, repoDirs) => {
      const out: string[] = [];
      if (/\bprisma\b/i.test(text) || repoDirs.some((d) => d === 'prisma' || d.endsWith('/prisma'))) {
        out.push('prisma/**');
      }
      if (
        /\b(?:database|db|queries|schema|migration|prisma|drizzle|typeorm|knex|sql)\b/i.test(text) &&
        !repoDirs.some((d) => d.endsWith('/db') || d === 'db' || d.endsWith('/database'))
      ) {
        out.push('src/db/**');
      }
      return out;
    },
  },
  {
    id: 'e2e',
    keywordRegex: /\b(?:playwright|cypress|e2e|end-to-end|browser\s+tests?)\b/i,
    dirSegments: ['e2e', 'cypress', 'playwright'],
    extensions: ['.spec.ts', '.spec.tsx', '.e2e.ts'],
    defaultGlobs: (text, repoDirs) => {
      const out: string[] = [];
      if (/\b(?:e2e|playwright|end-to-end)\b/i.test(text) && !repoDirs.some((d) => d === 'e2e' || d.endsWith('/e2e'))) {
        out.push('e2e/**');
      }
      if (/\b(?:playwright|e2e|cypress|spec)\b/i.test(text)) {
        out.push('**/*.spec.ts');
      }
      return out;
    },
  },
  {
    id: 'frontend',
    keywordRegex:
      /\b(?:react|components?|frontend|ui|tsx|jsx|tailwind|shadcn|css\s+modules|styled-components|next\.?js)\b/i,
    dirSegments: ['components', 'ui', 'frontend', 'web', 'pages', 'views', 'styles'],
    extensions: ['.tsx', '.jsx'],
    defaultGlobs: (text, repoDirs) => {
      const out: string[] = [];
      if (
        /\b(?:react|components?|ui|frontend)\b/i.test(text) &&
        !repoDirs.some((d) => d.endsWith('/components') || d === 'components')
      ) {
        out.push('src/components/**');
      }
      if (/\b(?:react|components?|tsx|jsx|ui|frontend)\b/i.test(text)) {
        out.push('**/*.tsx');
      }
      return out;
    },
  },
  {
    id: 'api',
    keywordRegex: /\b(?:api|endpoints?|controllers?|routers?|routes|graphql|trpc|webhooks?|middlewares?)\b/i,
    dirSegments: ['api', 'routes', 'controllers', 'graphql', 'trpc', 'webhooks', 'middleware', 'server'],
    extensions: ['.graphql', '.gql'],
    defaultGlobs: () => [],
  },
  {
    id: 'auth',
    keywordRegex: /\b(?:auth|authentication|authorization|oauth|jwt|rbac|permissions?)\b/i,
    dirSegments: ['auth', 'security', 'permissions'],
    extensions: [],
    defaultGlobs: (text, repoDirs) => {
      if (/\b(?:auth|authentication|authorization|oauth|jwt)\b/i.test(text) && !repoDirs.some((d) => d.endsWith('/auth') || d === 'auth')) {
        return ['src/auth/**'];
      }
      return [];
    },
  },
  {
    id: 'billing',
    keywordRegex: /\b(?:billing|payments?|stripe|invoices?|subscriptions?)\b/i,
    dirSegments: ['billing', 'payments', 'stripe'],
    extensions: [],
    defaultGlobs: () => [],
  },
  {
    id: 'infra',
    keywordRegex: /\b(?:docker|dockerfile|kubernetes|k8s|terraform|helm|infra|infrastructure)\b/i,
    dirSegments: ['infra', 'terraform', 'k8s', 'docker'],
    extensions: ['.tf'],
    defaultGlobs: () => [],
  },
];

function collectRepoDirectories(repoFiles: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of repoFiles) {
    const posix = toPosixPath(file);
    if (
      posix.startsWith('.claude/') ||
      posix.startsWith('.cursor/') ||
      posix.startsWith('.github/') ||
      posix.startsWith('.vscode/')
    ) {
      continue;
    }
    const parts = posix.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return Array.from(dirs).sort();
}

function extractExplicitSignalGlobs(section: RuleSection, repoDirs: string[]): string[] {
  const globs = new Set<string>();
  const rawCandidates = new Set<string>(section.referencedPaths);

  // Also scan inline code spans in rawContent for globs or extensions like `*.spec.ts`, `.tsx`, `src/db/**`, `e2e/**`
  const codeSpanRegex = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpanRegex.exec(section.rawContent)) !== null) {
    const token = m[1].trim();
    if (!token || token.includes(' ')) continue;
    if (/^\*\.[a-zA-Z0-9._-]+$/.test(token)) {
      rawCandidates.add(token);
    } else if (/^\.[a-zA-Z0-9]+$/.test(token) && token.length >= 3) {
      rawCandidates.add(`*${token}`);
    } else if (token.includes('/') && !/^(?:http|https|mailto):/.test(token)) {
      rawCandidates.add(token);
    }
  }

  for (const raw of rawCandidates) {
    const cleaned = toPosixPath(raw.trim().replace(/^[`'"]+|[`'",.:;!?)]+$/g, ''));
    if (!cleaned) continue;
    // Skip template placeholders
    if (/[<>]|\{[a-zA-Z0-9_]+\}|\$[A-Za-z_]/.test(cleaned)) continue;
    if (/^(?:origin|upstream)\//.test(cleaned)) continue;
    if (cleaned.startsWith('@') && !cleaned.includes('/')) continue;

    // Skip root config or harness files
    if (!cleaned.includes('/') && ROOT_CONFIG_OR_HARNESS_FILES.has(cleaned.toLowerCase())) {
      continue;
    }
    // Skip harness files in docs/ or .claude/ or .cursor/
    if (
      cleaned.startsWith('.claude/') ||
      cleaned.startsWith('.cursor/') ||
      cleaned.endsWith('CLAUDE.md') ||
      cleaned.endsWith('AGENTS.md')
    ) {
      continue;
    }

    if (cleaned.startsWith('*.')) {
      // e.g. *.spec.ts or *.tsx
      globs.add(`**/${cleaned}`);
      continue;
    }

    if (cleaned.includes('*')) {
      globs.add(cleaned);
      continue;
    }

    if (cleaned.endsWith('/')) {
      globs.add(`${cleaned.replace(/\/+$/, '')}/**`);
      continue;
    }

    const base = cleaned.split('/').pop() ?? '';
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(base);

    if (!hasExtension || repoDirs.includes(cleaned)) {
      // Directory reference (e.g. prisma/migrations, src/db, e2e)
      globs.add(`${cleaned}/**`);
      const topDir = cleaned.split('/')[0];
      if (topDir === 'prisma' || topDir === 'e2e' || topDir === 'cypress') {
        globs.add(`${topDir}/**`);
      }
    } else {
      // File reference (e.g. prisma/schema.prisma, packages/api/src/db.ts)
      const dir = cleaned.includes('/') ? cleaned.slice(0, cleaned.lastIndexOf('/')) : '';
      if (dir) {
        globs.add(`${dir}/**`);
      }
      globs.add(cleaned);
    }
  }

  return Array.from(globs);
}

function extractOntologySignalGlobs(
  section: RuleSection,
  repoDirs: string[],
  repoFiles: string[],
): string[] {
  const globs = new Set<string>();
  const combinedText = `${section.heading}\n${section.rawContent}`;

  for (const rule of ONTOLOGY_DOMAIN_RULES) {
    if (!rule.keywordRegex.test(combinedText)) continue;

    // 1. Align with actual repository directories
    for (const dir of repoDirs) {
      const segments = dir.toLowerCase().split('/');
      const lastSeg = segments[segments.length - 1];
      if (rule.dirSegments.includes(lastSeg)) {
        globs.add(`${dir}/**`);
      }
    }

    // 2. Align with actual repository file extensions
    for (const ext of rule.extensions) {
      if (repoFiles.some((f) => f.toLowerCase().endsWith(ext))) {
        globs.add(`**/*${ext}`);
      }
    }

    // 3. Apply domain canonical defaults
    for (const defGlob of rule.defaultGlobs(combinedText, repoDirs, repoFiles)) {
      globs.add(defGlob);
    }
  }

  // 4. Direct directory stem alignment against section heading/content
  const headingLower = section.heading.toLowerCase();
  for (const dir of repoDirs) {
    const segments = dir.split('/');
    const leaf = segments[segments.length - 1].toLowerCase();
    if (leaf.length < 3 || GENERIC_DIR_SEGMENTS.has(leaf)) continue;
    const singular = leaf.endsWith('s') && leaf.length > 3 ? leaf.slice(0, -1) : leaf;
    const stemRegex = new RegExp(`\\b(?:${leaf}|${singular})\\b`, 'i');
    if (stemRegex.test(headingLower)) {
      globs.add(`${dir}/**`);
    }
  }

  return Array.from(globs);
}

export function inferSectionScope(
  section: RuleSection,
  repoFiles: string[],
  totalSectionsInFile = 1,
): {
  isDomainSpecific: boolean;
  inferredGlobs: string[];
} {
  // If the section already has non-wildcard effectiveGlobs (e.g., scoped rule file or sync marker)
  const existingNarrowGlobs = section.effectiveGlobs.filter(
    (g) => g !== '**/*' && g !== '**' && g !== '*',
  );
  const repoDirs = collectRepoDirectories(repoFiles);

  if (!section.isAlwaysLoadedAtRoot && existingNarrowGlobs.length > 0) {
    const explicit = extractExplicitSignalGlobs(section, repoDirs);
    const merged = Array.from(new Set([...existingNarrowGlobs, ...explicit]));
    return {
      isDomainSpecific: true,
      inferredGlobs: merged,
    };
  }

  // Signal 3: Root retention check for preamble / top-level document heading / global sections
  if (section.headingLevel === 0) {
    return { isDomainSpecific: false, inferredGlobs: ['**/*'] };
  }

  if (
    section.headingLevel === 1 &&
    totalSectionsInFile > 1 &&
    !DOMAIN_HEADING_KEYWORDS.test(section.heading)
  ) {
    return { isDomainSpecific: false, inferredGlobs: ['**/*'] };
  }

  const isGlobalHeading =
    GLOBAL_HEADING_PATTERNS.some((re) => re.test(section.heading)) &&
    !DOMAIN_HEADING_KEYWORDS.test(section.heading);

  const explicitGlobs = extractExplicitSignalGlobs(section, repoDirs);
  if (isGlobalHeading && explicitGlobs.length === 0) {
    return { isDomainSpecific: false, inferredGlobs: ['**/*'] };
  }

  const ontologyGlobs = extractOntologySignalGlobs(section, repoDirs, repoFiles);
  const combined = Array.from(new Set([...ontologyGlobs, ...explicitGlobs]));

  if (combined.length === 0) {
    return { isDomainSpecific: false, inferredGlobs: ['**/*'] };
  }

  return {
    isDomainSpecific: true,
    inferredGlobs: combined,
  };
}

function slugifyHeading(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'scoped-rules';
}

function formatSplitFileContent(
  target: 'claude' | 'cursor',
  heading: string,
  globs: string[],
  bodyContent: string,
): string {
  if (target === 'cursor') {
    const globLines = globs.map((g) => `  - "${g}"`).join('\n');
    return [
      '---',
      `description: "${heading.replace(/"/g, '\\"')}"`,
      'globs:',
      globLines,
      'alwaysApply: false',
      '---',
      '',
      bodyContent.trim(),
      '',
    ].join('\n');
  }

  const pathLines = globs.map((g) => `  - "${g}"`).join('\n');
  return ['---', 'paths:', pathLines, '---', '', bodyContent.trim(), ''].join('\n');
}

export async function splitWorkspace(options: SplitWorkspaceOptions): Promise<SplitWorkspaceResult> {
  const target = options.target ?? 'claude';
  const shouldWrite = Boolean(options.write || options.fix);
  const config = loadWorkspaceConfig(options.cwd);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const rootCandidateFormats = new Set(['claude-md', 'agents-md', 'gemini-md', 'cursorrules']);
  const rootFiles = discovered.harnessFiles.filter(
    (hf) => hf.isAlwaysLoadedAtRoot && rootCandidateFormats.has(hf.format),
  );

  const proposedFiles: ProposedSplitFile[] = [];
  const updatedRootFiles: SplitWorkspaceResult['updatedRootFiles'] = [];
  let turn0TokensBefore = 0;
  let turn0TokensAfter = 0;

  for (const hf of rootFiles) {
    const originalTokens = estimateTokenCount(hf.rawContent);
    turn0TokensBefore += originalTokens;

    if (hf.sections.length <= 1) {
      turn0TokensAfter += originalTokens;
      continue;
    }

    const retainedSections: RuleSection[] = [];
    const extractedSections: Array<{ section: RuleSection; inferredGlobs: string[] }> = [];

    for (let idx = 0; idx < hf.sections.length; idx++) {
      const sec = hf.sections[idx];
      const scopeInfo = inferSectionScope(sec, discovered.repoFiles, hf.sections.length);
      // Always retain the first root/title preamble section if it's level 0 or level 1
      if (idx === 0 && sec.headingLevel <= 1 && !DOMAIN_HEADING_KEYWORDS.test(sec.heading)) {
        retainedSections.push(sec);
        continue;
      }

      if (scopeInfo.isDomainSpecific && scopeInfo.inferredGlobs.length > 0) {
        extractedSections.push({ section: sec, inferredGlobs: scopeInfo.inferredGlobs });
      } else {
        retainedSections.push(sec);
      }
    }

    if (extractedSections.length === 0) {
      turn0TokensAfter += originalTokens;
      continue;
    }

    if (retainedSections.length === 0) {
      // Retain at least the first section in root so the root file isn't emptied completely
      const first = extractedSections.shift()!;
      retainedSections.push(first.section);
    }

    if (extractedSections.length === 0) {
      turn0TokensAfter += originalTokens;
      continue;
    }

    const usedSlugs = new Set<string>();
    for (const item of extractedSections) {
      let slug = slugifyHeading(item.section.heading);
      if (usedSlugs.has(slug)) {
        let counter = 2;
        while (usedSlugs.has(`${slug}-${counter}`)) counter++;
        slug = `${slug}-${counter}`;
      }
      usedSlugs.add(slug);

      const targetPath =
        target === 'cursor' ? `.cursor/rules/${slug}.mdc` : `.claude/rules/${slug}.md`;
      const content = formatSplitFileContent(
        target,
        item.section.heading,
        item.inferredGlobs,
        item.section.rawContent,
      );
      const tokenSavings = estimateTokenCount(item.section.rawContent);
      const lineCount = content.split(/\r?\n/).length;

      proposedFiles.push({
        targetPath,
        sourceFile: hf.path,
        sections: [item.section],
        inferredGlobs: item.inferredGlobs,
        content,
        tokenSavings,
        lineCount,
      });
    }

    const updatedContent = retainedSections.map((s) => s.rawContent.trim()).join('\n\n') + '\n';
    const remainingTokens = estimateTokenCount(updatedContent);
    turn0TokensAfter += remainingTokens;

    updatedRootFiles.push({
      path: hf.path,
      originalTokens,
      remainingTokens,
      content: updatedContent,
    });
  }

  if (shouldWrite && proposedFiles.length > 0) {
    for (const pf of proposedFiles) {
      const absTarget = path.resolve(options.cwd, pf.targetPath);
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, pf.content, 'utf8');
    }
    for (const rf of updatedRootFiles) {
      const absRoot = path.resolve(options.cwd, rf.path);
      fs.writeFileSync(absRoot, rf.content, 'utf8');
    }
  }

  const reductionPercent =
    turn0TokensBefore > 0
      ? Math.max(
          0,
          Math.round(((turn0TokensBefore - turn0TokensAfter) / turn0TokensBefore) * 10000) / 100,
        )
      : 0;

  return {
    cwd: options.cwd,
    target,
    written: shouldWrite && proposedFiles.length > 0,
    proposedFiles,
    updatedRootFiles,
    turn0TokensBefore,
    turn0TokensAfter,
    reductionPercent,
  };
}
