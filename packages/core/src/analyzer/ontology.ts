import type { DirectiveNode, ImperativeModality } from '../types.js';

export interface CanonicalAssertion {
  topic: string;
  action: string;
  target: string;
  polarity: 'POSITIVE' | 'NEGATIVE';
  strength: 'HARD' | 'SOFT';
  condition?: string;
  excludedPaths: string[];
}

const TARGET_SYNONYMS: Record<string, string> = {
  db: 'database',
  databases: 'database',
  sql_database: 'database',
  postgres: 'database',
  postgresql: 'database',
  mysql: 'database',
  sqlite: 'database',
  prisma_calls: 'prisma',
  prisma_client: 'prisma',
  drizzle_orm: 'drizzle',
  testcontainer: 'testcontainers',
  docker_containers: 'docker',
  docker_dependencies: 'docker',
  default_exports: 'default_export',
  export_default: 'default_export',
  named_exports: 'named_export',
  esm: 'esm',
  es_modules: 'esm',
  es_module: 'esm',
  ecmascript_modules: 'esm',
  cjs: 'commonjs',
  common_js: 'commonjs',
  require: 'commonjs',
  any: 'any_type',
  explicit_any: 'any_type',
  as_cast: 'type_assertion',
  type_assertions: 'type_assertion',
  ts_ignore: 'ts_ignore',
  ts_expect_error: 'ts_ignore',
  non_null_assertion: 'non_null_assertion',
  tailwind_css: 'tailwind',
  tailwindcss: 'tailwind',
  css_module: 'css_modules',
  styled_component: 'styled_components',
  inline_style: 'inline_styles',
  force_pushing: 'force_push',
  git_rebase: 'rebase',
  rebasing: 'rebase',
  merge_commits: 'merge_commit',
  squash_merging: 'squash_merge',
  no_verify: 'bypass_hooks',
  commit_hooks: 'commit_hooks',
  pre_commit_hooks: 'commit_hooks',
};

/**
 * Subtype / hyponym map: key is a subtype of value (key ⊑ value).
 */
const SUBTYPE_PARENTS: Record<string, string[]> = {
  prisma: ['database'],
  drizzle: ['database'],
  typeorm: ['database'],
  knex: ['database'],
  sequelize: ['database'],
  mongoose: ['database'],
  sql: ['database'],
};

/**
 * Single-choice mutual exclusion groups: choosing POSITIVE `use` on one target
 * conflicts with POSITIVE `use` on another target in the same group.
 */
const SINGLE_CHOICE_GROUPS: Record<string, Set<string>> = {
  package_manager: new Set(['pnpm', 'npm', 'yarn', 'bun']),
  test_runner_unit: new Set(['vitest', 'jest', 'mocha', 'ava']),
  test_runner_e2e: new Set(['playwright', 'cypress']),
  export_style: new Set(['default_export', 'named_export']),
  module_system: new Set(['esm', 'commonjs']),
  styling: new Set(['tailwind', 'css_modules', 'styled_components', 'inline_styles']),
  error_handling: new Set(['exceptions', 'result_type']),
  git_merge: new Set(['rebase', 'merge_commit', 'squash_merge']),
  runtime: new Set(['node', 'deno', 'bun_runtime']),
};

const ANTONYM_ACTIONS: Array<[string, string]> = [
  ['enable', 'disable'],
  ['allow', 'forbid'],
  ['include', 'exclude'],
  ['keep', 'remove'],
  ['commit', 'ignore'],
  ['mock', 'unmock'],
];

const DISJOINT_CONDITION_GROUPS: Array<Set<string>> = [
  new Set(['unit_tests', 'integration_tests', 'e2e_tests']),
  new Set(['production', 'development', 'staging']),
  new Set(['frontend', 'backend']),
];

export function modalityPolarity(modality: ImperativeModality): 'POSITIVE' | 'NEGATIVE' {
  return modality === 'MUST_NOT' || modality === 'SHOULD_NOT' ? 'NEGATIVE' : 'POSITIVE';
}

export function modalityStrength(modality: ImperativeModality): 'HARD' | 'SOFT' {
  return modality === 'MUST' || modality === 'MUST_NOT' ? 'HARD' : 'SOFT';
}

export function normalizeCondition(rawText: string, rawCond?: string): string | undefined {
  const combined = `${rawText} ${rawCond ?? ''}`.toLowerCase();
  if (/\bunit\s+tests?\b/.test(combined)) return 'unit_tests';
  if (/\bintegration\s+tests?\b/.test(combined)) return 'integration_tests';
  if (/\b(?:e2e|end-to-end|playwright|cypress)\s+tests?\b/.test(combined)) return 'e2e_tests';
  if (/\bin\s+prod(?:uction)?\b/.test(combined)) return 'production';
  if (/\bin\s+dev(?:elopment)?\b/.test(combined)) return 'development';
  return undefined;
}

export function extractExcludedPathsFromProse(rawText: string): string[] {
  const excluded: string[] = [];
  // Matches: "except in packages/legacy/**", "(except in packages/api/**, packages/web/**)", "outside of packages/legacy/**"
  const regex =
    /\b(?:except(?:\s+in|\s+for|\s+under)?|outside(?:\s+of)?|excluding|unless\s+in)\s+([`A-Za-z0-9_./*,\s-]+?)(?=[.)!?;]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(rawText)) !== null) {
    const rawList = m[1];
    for (const part of rawList.split(/,|\band\b/i)) {
      const cleaned = part.replace(/^[`'"]+|[`'",.:;!?)]+$/g, '').trim();
      if (cleaned && /[/*.]/.test(cleaned)) {
        excluded.push(cleaned);
      }
    }
  }
  return excluded;
}

export function canonicalizeTarget(rawTarget: string): string {
  const clean = rawTarget.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TARGET_SYNONYMS[clean] ?? clean;
}

export function extractCanonicalAssertions(directive: DirectiveNode): CanonicalAssertion[] {
  const raw = directive.rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\([^)]*\bexcept\b[^)]*\)/gi, '')
    .replace(/\b(?:except(?:\s+in|\s+for|\s+under)?|outside(?:\s+of)?|excluding)\s+[`"]?[A-Za-z0-9_./*-]+[`"]?/gi, '')
    .trim();
  const lower = raw.toLowerCase();
  const basePolarity = modalityPolarity(directive.modality);
  const strength = modalityStrength(directive.modality);
  const condition = normalizeCondition(raw, directive.predicate.condition);
  const excludedPaths = [
    ...extractExcludedPathsFromProse(directive.rawText),
    ...directive.overrideGlobs,
    ...directive.effectiveGlobs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)),
  ];

  const assertions: CanonicalAssertion[] = [];
  const pushAssertion = (
    topic: string,
    action: string,
    target: string,
    polarity: 'POSITIVE' | 'NEGATIVE' = basePolarity,
  ) => {
    const canonTarget = canonicalizeTarget(target);
    assertions.push({
      topic,
      action,
      target: canonTarget,
      polarity,
      strength,
      condition,
      excludedPaths,
    });

    // Entailment chains (ADR-0001):
    // 1. POSITIVE use(testcontainers) => POSITIVE use(docker)
    if (topic === 'db_mocking' && action === 'use' && canonTarget === 'testcontainers' && polarity === 'POSITIVE') {
      assertions.push({
        topic: 'db_mocking',
        action: 'use',
        target: 'docker',
        polarity: 'POSITIVE',
        strength,
        condition,
        excludedPaths,
      });
    }
  };

  // 1. Package Manager
  const pkgMatch = /\b(pnpm|npm|yarn|bun)\b/.exec(lower);
  if (pkgMatch && !/\bbun\s+runtime\b/.test(lower)) {
    pushAssertion('package_manager', 'use', pkgMatch[1]);
  }

  // 2. Test Runners
  const unitRunnerMatch = /\b(vitest|jest|mocha|ava)\b/.exec(lower);
  if (unitRunnerMatch) {
    pushAssertion('test_runner_unit', 'use', unitRunnerMatch[1]);
  }
  const e2eRunnerMatch = /\b(playwright|cypress)\b/.exec(lower);
  if (e2eRunnerMatch) {
    pushAssertion('test_runner_e2e', 'use', e2eRunnerMatch[1]);
  }

  // 3. Database Mocking & Docker / Testcontainers
  if (/\bmock(?:ing|ed|s)?\b/.test(lower)) {
    const dbTargetMatch = /\b(prisma|drizzle|typeorm|knex|sequelize|mongoose|database|databases|db|sql|postgres|postgresql|mysql|sqlite)\b/.exec(
      lower,
    );
    if (dbTargetMatch) {
      pushAssertion('db_mocking', 'mock', dbTargetMatch[1]);
    }
  }
  if (/\btestcontainers?\b/.test(lower)) {
    pushAssertion('db_mocking', 'use', 'testcontainers');
  }
  if (/\bdocker\b/.test(lower)) {
    const dockerPolarity = /\b(?:zero|no|without)\s+docker\b/.test(lower) ? 'NEGATIVE' : basePolarity;
    pushAssertion('db_mocking', 'use', 'docker', dockerPolarity);
  }

  // 4. Export Style
  if (/\bdefault\s+exports?\b|\bexport\s+default\b/.test(lower)) {
    pushAssertion('export_style', 'use', 'default_export');
  } else if (/\bnamed\s+exports?\b/.test(lower)) {
    pushAssertion('export_style', 'use', 'named_export');
  }

  // 5. Module System (ESM vs CommonJS)
  if (/\b(?:esm|es\s+modules?|ecmascript\s+modules?|import\/export)\b/.test(lower)) {
    pushAssertion('module_system', 'use', 'esm');
  } else if (/\b(?:commonjs|cjs|require\(\)|module\.exports)\b/.test(lower)) {
    pushAssertion('module_system', 'use', 'commonjs');
  }

  // 6. Type Safety
  if (/\b(?:any\s+types?|explicit\s+any|`any`)\b/.test(lower)) {
    pushAssertion('type_safety', 'use', 'any_type');
  } else if (/\b(?:type\s+assertions?|`as`\s+casts?|as\s+assertions?)\b/.test(lower)) {
    pushAssertion('type_safety', 'use', 'type_assertion');
  } else if (/\b(?:@ts-ignore|@ts-expect-error|ts-ignore)\b/.test(lower)) {
    pushAssertion('type_safety', 'use', 'ts_ignore');
  } else if (/\bstrict\s+mode\b/.test(lower)) {
    const isDisable = /\bdisable\b/.test(lower);
    pushAssertion('type_safety', 'use', 'strict_mode', isDisable ? 'NEGATIVE' : basePolarity);
  }

  // 7. Styling
  if (/\b(?:tailwind(?:css)?)\b/.test(lower)) {
    pushAssertion('styling', 'use', 'tailwind');
  } else if (/\bcss\s+modules?\b/.test(lower)) {
    pushAssertion('styling', 'use', 'css_modules');
  } else if (/\bstyled[- ]components?\b/.test(lower)) {
    pushAssertion('styling', 'use', 'styled_components');
  } else if (/\binline\s+styles?\b/.test(lower)) {
    pushAssertion('styling', 'use', 'inline_styles');
  }

  // 8. Git Workflow
  if (/\bforce[- ]push(?:ing)?\b/.test(lower)) {
    pushAssertion('git_workflow', 'use', 'force_push');
  } else if (/\b(?:--no-verify|bypass(?:ing)?\s+(?:git\s+|pre-commit\s+|commit\s+)?hooks?)\b/.test(lower)) {
    pushAssertion('git_workflow', 'use', 'bypass_hooks');
  } else if (/\brebas(?:e|ing)\b/.test(lower)) {
    pushAssertion('git_merge', 'use', 'rebase');
  } else if (/\bmerge\s+commits?\b/.test(lower)) {
    pushAssertion('git_merge', 'use', 'merge_commit');
  } else if (/\bsquash\s+merg(?:e|ing)\b/.test(lower)) {
    pushAssertion('git_merge', 'use', 'squash_merge');
  }

  // 9. Error Handling
  if (/\b(?:result\s+types?|neverthrow)\b/.test(lower)) {
    pushAssertion('error_handling', 'use', 'result_type');
  } else if (/\bthrow(?:ing)?\s+(?:raw\s+)?(?:exceptions?|errors?)\b/.test(lower)) {
    pushAssertion('error_handling', 'use', 'exceptions');
  }

  // 10. Generic Fallback if no domain assertion matched
  if (assertions.length === 0) {
    pushAssertion(
      directive.topic,
      directive.predicate.action.toLowerCase(),
      directive.predicate.target.toLowerCase(),
    );
  }

  return assertions;
}

export function areConditionsCompatible(condA?: string, condB?: string): boolean {
  if (!condA || !condB) return true;
  if (condA === condB) return true;
  for (const group of DISJOINT_CONDITION_GROUPS) {
    if (group.has(condA) && group.has(condB)) {
      return false;
    }
  }
  return true;
}

export function targetsMatchOrSubtype(targetA: string, targetB: string): boolean {
  if (targetA === targetB) return true;
  const parentsA = SUBTYPE_PARENTS[targetA] ?? [];
  if (parentsA.includes(targetB)) return true;
  const parentsB = SUBTYPE_PARENTS[targetB] ?? [];
  if (parentsB.includes(targetA)) return true;
  return false;
}

export function areActionsAntonymous(actionA: string, actionB: string): boolean {
  for (const [left, right] of ANTONYM_ACTIONS) {
    if ((actionA === left && actionB === right) || (actionA === right && actionB === left)) {
      return true;
    }
  }
  return false;
}

export function doAssertionsConflict(a: CanonicalAssertion, b: CanonicalAssertion): {
  conflicts: boolean;
  reason?: string;
} {
  // Note: allow conditioned rules to still conflict with unconditional rules on the same scope
  // (e.g. "Never mock the database" vs "In unit tests, mock all Prisma calls"),
  // and only suppress when BOTH specify mutually exclusive conditions (e.g. unit_tests vs integration_tests)!
  if (!areConditionsCompatible(a.condition, b.condition)) {
    return { conflicts: false };
  }

  if (a.topic !== b.topic) {
    return { conflicts: false };
  }

  // Case 1: Same action & matching/subtype target with opposite polarity
  if (a.action === b.action && targetsMatchOrSubtype(a.target, b.target) && a.polarity !== b.polarity) {
    return {
      conflicts: true,
      reason: `Conflicting obligations on '${a.action}(${a.target})' vs '${b.action}(${b.target})'`,
    };
  }

  // Case 2: Antonymous actions on the same/subtype target with the SAME polarity
  if (
    areActionsAntonymous(a.action, b.action) &&
    targetsMatchOrSubtype(a.target, b.target) &&
    a.polarity === b.polarity
  ) {
    return {
      conflicts: true,
      reason: `Antonymous actions '${a.action}' vs '${b.action}' on '${a.target}'`,
    };
  }

  // Case 3: Single-choice mutual exclusion group (both POSITIVE on `use` for distinct targets in the same exclusive group)
  const exclusiveSet = SINGLE_CHOICE_GROUPS[a.topic];
  if (
    exclusiveSet &&
    a.action === 'use' &&
    b.action === 'use' &&
    a.polarity === 'POSITIVE' &&
    b.polarity === 'POSITIVE' &&
    a.target !== b.target &&
    exclusiveSet.has(a.target) &&
    exclusiveSet.has(b.target)
  ) {
    return {
      conflicts: true,
      reason: `Mutually exclusive '${a.topic}' targets '${a.target}' vs '${b.target}'`,
    };
  }

  return { conflicts: false };
}
