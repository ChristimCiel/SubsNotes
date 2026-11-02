import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Generic rules only. Never put a maintainer's private identifiers in this public file.
export function publicationProblems(path, text) {
  const problems = [];
  const file = path.split('/').at(-1);
  if (/^(?:AGENTS\.md|CHANGELOG\.md|QA\.md|VALIDATION\.md|(?:ROADMAP|EXECUTION_PLAN|NEXT_VERSION_PLAN|TEAM_CONTRACT|BASELINE_VALIDATION|SECURITY_REVIEW|PERSONA_EVALUATION)(?:[._-].*)?)$/i.test(file)) {
    problems.push('private maintainer document');
  }
  if (/\.(?:md|txt|rst|html?)$/i.test(path) && /(?:^#{1,6}\s+|<h[1-6][^>]*>)[^\n<]*(?:execution plan|implementation roadmap|implementation backlog|engineering milestones|work packages|team contract|persona evaluation)/im.test(text)) {
    problems.push('internal planning content');
  }
  if ((/^\.env(?:\.|$)/.test(file) && file !== '.env.example') ||
      /^(?:GmailDesktopClient|client_secret.*|messages-\d+|snapshot|evidence|scan-state)\.json$/.test(file) ||
      file === 'review.html' || /(?:^|\/)(?:\.private|private-audit|node_modules)(?:\/|$)/.test(path)) {
    problems.push('private or generated file');
  }
  const rules = [
    ['developer home path', /\/Users\/(?!runner(?:\/|\b)|example(?:\/|\b)|you(?:\/|\b)|YOUR_USER(?:\/|\b))[^/\s"'<>]+/],
    ['Windows user path', /[A-Za-z]:\\Users\\(?!runneradmin\\|example\\|YOUR_USER\\)[^\\\s"'<>]+/],
    ['personal mailbox literal', /\b[A-Z0-9._%+-]+@(?:gmail|yahoo|outlook|hotmail|icloud|protonmail)\.com\b/i],
    ['credential material', /\b(?:ya29\.[A-Za-z0-9_-]{12,}|GOCSPX-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{24,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,})\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
  ];
  for (const [label, pattern] of rules) if (pattern.test(text)) problems.push(label);
  for (const value of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) {
    const n = value[0].split('.').map(Number);
    if (n.some(x => x > 255)) continue;
    const documentation = (n[0] === 192 && n[1] === 0 && n[2] === 2) ||
      (n[0] === 198 && n[1] === 51 && n[2] === 100) || (n[0] === 203 && n[1] === 0 && n[2] === 113);
    if (n[0] !== 127 && !documentation) { problems.push('non-loopback IPv4 literal'); break; }
  }
  return [...new Set(problems)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const staged = process.argv.includes('--staged');
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  const paths = execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
  let failed = 0;
  for (const path of paths) {
    const data = staged ? execFileSync('git', ['show', ':' + path]) : readFileSync(path);
    if (data.includes(0)) continue; // Do not interpret binary assets as text.
    const issues = publicationProblems(path, data.toString('utf8'));
    if (issues.length) { failed++; console.error(`${path}: ${issues.join(', ')}`); }
  }
  if (failed) { console.error(`Publication blocked: ${failed} file(s). Values are intentionally not logged.`); process.exitCode = 1; }
  else console.log(`Publication text/path checks passed for ${paths.length} ${staged ? 'staged' : 'tracked'} files. This is not a full PII, history or secret audit.`);
}
