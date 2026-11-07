import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, DiagnosticFix } from '../types.js';

export function applyFixesToWorkspace(cwd: string, diagnostics: Diagnostic[]): DiagnosticFix[] {
  const applied: DiagnosticFix[] = [];
  const editsByFile = new Map<string, Array<{ oldText?: string; newText: string; replaceFullFile?: boolean }>>();

  for (const diag of diagnostics) {
    if (!diag.fix) continue;
    applied.push(diag.fix);
    for (const edit of diag.fix.edits) {
      const list = editsByFile.get(edit.file) ?? [];
      list.push(edit);
      editsByFile.set(edit.file, list);
    }
  }

  for (const [relFile, edits] of editsByFile.entries()) {
    const absPath = path.resolve(cwd, relFile);
    let content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    for (const edit of edits) {
      if (edit.replaceFullFile) {
        content = edit.newText;
      } else if (edit.oldText !== undefined) {
        content = content.split(edit.oldText).join(edit.newText);
      }
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }

  return applied;
}
