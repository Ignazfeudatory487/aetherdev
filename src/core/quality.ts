/**
 * AetherDev — Code Quality Gates
 * Linting, security scanning, cyclomatic complexity, performance profiling
 * 100% local — no cloud scanning services required
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { getLogger } from '../utils/logger.js';
import { getSandbox } from './sandbox.js';
import { readFileSafe, detectLanguage } from '../utils/fs.js';

const logger = getLogger('quality');

// ─── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface QualityIssue {
  id: string;
  severity: Severity;
  category: 'security' | 'complexity' | 'style' | 'performance' | 'maintainability' | 'bug';
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  rule?: string;
  suggestion?: string;
}

export interface QualityReport {
  filePath: string;
  language: string;
  issues: QualityIssue[];
  metrics: CodeMetrics;
  passed: boolean;
  score: number; // 0-100
  summary: string;
}

export interface CodeMetrics {
  linesOfCode: number;
  linesOfComments: number;
  blankLines: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  maintainabilityIndex: number;
  duplicatedLines: number;
  functionCount: number;
  classCount: number;
  maxFunctionLength: number;
  maxNestingDepth: number;
  commentRatio: number;
}

export interface SecurityScanResult {
  vulnerabilities: SecurityVulnerability[];
  riskScore: number;
  passed: boolean;
}

export interface SecurityVulnerability {
  id: string;
  cwe?: string;
  severity: Severity;
  title: string;
  description: string;
  filePath: string;
  line?: number;
  code?: string;
  fix?: string;
}

// ─── Complexity Analyzer ──────────────────────────────────────────────────────

export class ComplexityAnalyzer {
  /**
   * Cyclomatic complexity: counts decision points
   * Score: 1-10 simple, 11-20 moderate, 21-50 complex, >50 untestable
   */
  calculateCyclomatic(code: string, language: string): number {
    let complexity = 1; // Base

    const decisionPatterns: Record<string, RegExp[]> = {
      javascript: [
        /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
        /\bdo\s*\{/g, /\bcase\s+.+:/g, /\bcatch\s*\(/g, /\?\s*[^:]+:/g,
        /&&/g, /\|\|/g, /\?\?/g,
      ],
      typescript: [
        /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
        /\bdo\s*\{/g, /\bcase\s+.+:/g, /\bcatch\s*\(/g, /\?\s*[^:]+:/g,
        /&&/g, /\|\|/g, /\?\?/g, /\bswitch\s*\(/g,
      ],
      python: [
        /\bif\s+/g, /\belif\s+/g, /\bfor\s+/g, /\bwhile\s+/g,
        /\bexcept\s/g, /\band\s/g, /\bor\s/g, /\bwith\s+/g,
      ],
    };

    const lang = language in decisionPatterns ? language : 'javascript';
    const patterns = decisionPatterns[lang]!;

    const strippedCode = this.stripCommentsAndStrings(code, language);
    for (const pattern of patterns) {
      const matches = strippedCode.match(pattern) ?? [];
      complexity += matches.length;
    }

    return complexity;
  }

  /**
   * Cognitive complexity: how hard it is to understand (Google's metric)
   * Penalizes deeply nested structures more
   */
  calculateCognitive(code: string): number {
    let complexity = 0;
    let nestingLevel = 0;
    const lines = code.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Increase nesting for structural constructs
      if (/\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\bcatch\b|\bdo\b/.test(trimmed)) {
        complexity += 1 + nestingLevel;
        nestingLevel++;
      }
      // Binary logical operators (flat penalty)
      const logicalOps = (trimmed.match(/&&|\|\|/g) ?? []).length;
      complexity += logicalOps;

      // Reduce nesting on closing braces
      if (trimmed === '}' || trimmed === '};' || trimmed === '},') {
        nestingLevel = Math.max(0, nestingLevel - 1);
      }

      // Recursion penalty
      if (/\bfunction\b|\bdef\b/.test(trimmed) && trimmed.includes('(')) {
        const funcName = trimmed.match(/(?:function|def)\s+(\w+)/)?.[1];
        if (funcName && code.includes(`${funcName}(`)) {
          complexity += 1; // Recursive call
        }
      }
    }

    return complexity;
  }

  calculateNestingDepth(code: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of code) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }
    return maxDepth;
  }

  countFunctions(code: string, language: string): number {
    const patterns: Record<string, RegExp> = {
      typescript: /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|\w+\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{)/g,
      python: /def\s+\w+\s*\(/g,
      javascript: /function\s+\w+|=>\s*\{|\w+\s*:\s*function/g,
    };
    const pattern = patterns[language] ?? patterns['javascript']!;
    return (code.match(pattern) ?? []).length;
  }

  /**
   * Maintainability Index (Microsoft formula)
   * MI = MAX(0, (171 - 5.2 * ln(HV) - 0.23 * CC - 16.2 * ln(LOC)) * 100 / 171)
   */
  calculateMaintainability(loc: number, complexity: number, halsteadVolume: number): number {
    if (loc <= 0) return 100;
    const mi = Math.max(0, (171 - 5.2 * Math.log(halsteadVolume + 1) - 0.23 * complexity - 16.2 * Math.log(loc + 1)) * 100 / 171);
    return Math.min(100, Math.round(mi));
  }

  private stripCommentsAndStrings(code: string, language: string): string {
    let stripped = code;
    // Remove string literals
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    // Remove line comments
    stripped = stripped.replace(/\/\/.*/g, '');
    // Remove block comments
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
    if (language === 'python') {
      stripped = stripped.replace(/#.*/g, '');
      stripped = stripped.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""');
    }
    return stripped;
  }
}

// ─── Security Scanner ─────────────────────────────────────────────────────────

export class SecurityScanner {
  private readonly HIGH_RISK_PATTERNS: Array<{
    pattern: RegExp;
    title: string;
    cwe: string;
    severity: Severity;
    fix: string;
    languages?: string[];
  }> = [
    {
      pattern: /eval\s*\(/g,
      title: 'Dangerous eval() usage',
      cwe: 'CWE-95',
      severity: 'critical',
      fix: 'Avoid eval(). Use JSON.parse() or safer alternatives.',
    },
    {
      pattern: /exec\s*\(\s*(?:req|request|body|params|query|input)/g,
      title: 'Command injection via user input',
      cwe: 'CWE-78',
      severity: 'critical',
      fix: 'Never pass user input directly to exec(). Use allowlists and sanitize input.',
    },
    {
      pattern: /innerHTML\s*=\s*(?!['"`])/g,
      title: 'Potential XSS via innerHTML',
      cwe: 'CWE-79',
      severity: 'high',
      fix: 'Use textContent or sanitize with DOMPurify before setting innerHTML.',
      languages: ['javascript', 'typescript'],
    },
    {
      pattern: /document\.write\s*\(/g,
      title: 'Insecure document.write()',
      cwe: 'CWE-79',
      severity: 'high',
      fix: 'Avoid document.write(). Use DOM manipulation methods instead.',
    },
    {
      pattern: /require\s*\(\s*(?:req|request|body|params|query|input)/g,
      title: 'Dynamic require() with user input',
      cwe: 'CWE-98',
      severity: 'critical',
      fix: 'Never use require() with user-controlled strings.',
    },
    {
      pattern: /password\s*=\s*['"`][^'"` ]{3,}['"`]/gi,
      title: 'Hardcoded password detected',
      cwe: 'CWE-259',
      severity: 'critical',
      fix: 'Use environment variables. Never hardcode credentials.',
    },
    {
      pattern: /api[_-]?key\s*=\s*['"`][a-zA-Z0-9_\-]{10,}['"`]/gi,
      title: 'Hardcoded API key detected',
      cwe: 'CWE-312',
      severity: 'critical',
      fix: 'Move API keys to environment variables (.env file).',
    },
    {
      pattern: /secret\s*=\s*['"`][^'"` ]{8,}['"`]/gi,
      title: 'Hardcoded secret detected',
      cwe: 'CWE-312',
      severity: 'high',
      fix: 'Use environment variables for secrets.',
    },
    {
      pattern: /Math\.random\s*\(\s*\)/g,
      title: 'Cryptographically weak random number',
      cwe: 'CWE-338',
      severity: 'medium',
      fix: 'Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive operations.',
    },
    {
      pattern: /md5\s*\(/gi,
      title: 'Weak MD5 hashing algorithm',
      cwe: 'CWE-327',
      severity: 'high',
      fix: 'Use SHA-256 or bcrypt/argon2 for password hashing.',
    },
    {
      pattern: /sha1\s*\(/gi,
      title: 'Weak SHA1 hashing algorithm',
      cwe: 'CWE-327',
      severity: 'medium',
      fix: 'Use SHA-256 or better.',
    },
    {
      pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/g,
      title: 'Insecure HTTP (non-TLS) connection',
      cwe: 'CWE-319',
      severity: 'medium',
      fix: 'Use HTTPS for all external communications.',
    },
    {
      pattern: /verify\s*:\s*false|rejectUnauthorized\s*:\s*false/g,
      title: 'SSL/TLS verification disabled',
      cwe: 'CWE-295',
      severity: 'critical',
      fix: 'Never disable SSL verification in production.',
    },
    {
      pattern: /process\.env\.NODE_ENV\s*!==?\s*['"`]production['"`]/g,
      title: 'Insecure dev-mode check',
      cwe: 'CWE-489',
      severity: 'low',
      fix: 'Avoid deploying with development-mode checks in production code.',
    },
    {
      pattern: /subprocess\.call\s*\(.+shell\s*=\s*True/g,
      title: 'Shell injection risk in subprocess',
      cwe: 'CWE-78',
      severity: 'critical',
      fix: 'Use shell=False and pass arguments as a list.',
      languages: ['python'],
    },
    {
      pattern: /pickle\.loads?\s*\(/g,
      title: 'Insecure pickle deserialization',
      cwe: 'CWE-502',
      severity: 'critical',
      fix: 'Never deserialize untrusted data with pickle. Use JSON instead.',
      languages: ['python'],
    },
    {
      pattern: /sql\s*=\s*f?['"`].*\{/gi,
      title: 'Potential SQL injection via string formatting',
      cwe: 'CWE-89',
      severity: 'critical',
      fix: 'Use parameterized queries / prepared statements.',
    },
  ];

  async scan(filePath: string, content: string): Promise<SecurityScanResult> {
    const language = detectLanguage(filePath);
    const lines = content.split('\n');
    const vulnerabilities: SecurityVulnerability[] = [];

    for (const rule of this.HIGH_RISK_PATTERNS) {
      if (rule.languages && !rule.languages.includes(language)) continue;

      let match: RegExpExecArray | null;
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');

      while ((match = regex.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        const codeLine = lines[lineNum - 1]?.trim();

        // Skip test files for some rules
        if (filePath.includes('test') || filePath.includes('spec')) {
          if (rule.severity === 'low' || rule.severity === 'info') continue;
        }

        vulnerabilities.push({
          id: `${rule.cwe}-${lineNum}`,
          cwe: rule.cwe,
          severity: rule.severity,
          title: rule.title,
          description: `Found at line ${lineNum}: ${codeLine?.slice(0, 80)}`,
          filePath,
          line: lineNum,
          code: codeLine,
          fix: rule.fix,
        });

        // Avoid reporting same issue 3+ times in same file
        const sameRuleCount = vulnerabilities.filter(v => v.cwe === rule.cwe).length;
        if (sameRuleCount >= 3) break;
      }
    }

    // Deduplicate by line
    const unique = vulnerabilities.filter((v, i, arr) =>
      arr.findIndex(x => x.line === v.line && x.cwe === v.cwe) === i
    );

    const riskScore = this.calculateRiskScore(unique);
    return {
      vulnerabilities: unique,
      riskScore,
      passed: riskScore < 50 && !unique.some(v => v.severity === 'critical'),
    };
  }

  private calculateRiskScore(vulns: SecurityVulnerability[]): number {
    const weights: Record<Severity, number> = {
      critical: 25, high: 15, medium: 8, low: 3, info: 1,
    };
    const score = vulns.reduce((s, v) => s + (weights[v.severity] ?? 0), 0);
    return Math.min(100, score);
  }
}

// ─── Full Quality Gate ────────────────────────────────────────────────────────

export class QualityGate {
  private readonly complexityAnalyzer = new ComplexityAnalyzer();
  private readonly securityScanner = new SecurityScanner();
  private readonly sandbox = getSandbox();

  async analyze(filePath: string): Promise<QualityReport> {
    const content = await readFileSafe(filePath);
    if (!content) {
      return this.emptyReport(filePath, 'Could not read file');
    }

    const language = detectLanguage(filePath);
    const lines = content.split('\n');

    // Calculate metrics
    const loc = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
    const commentLines = lines.filter(l => {
      const t = l.trim();
      return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
    }).length;
    const blankLines = lines.filter(l => !l.trim()).length;

    const cyclomaticComplexity = this.complexityAnalyzer.calculateCyclomatic(content, language);
    const cognitiveComplexity = this.complexityAnalyzer.calculateCognitive(content);
    const nestingDepth = this.complexityAnalyzer.calculateNestingDepth(content);
    const functionCount = this.complexityAnalyzer.countFunctions(content, language);
    const halsteadVolume = loc * Math.log2(Math.max(1, loc / 2));
    const maintainabilityIndex = this.complexityAnalyzer.calculateMaintainability(loc, cyclomaticComplexity, halsteadVolume);

    // Detect longest function
    const funcMatches = content.match(/(?:function\s+\w+|def\s+\w+)[^{]*\{[^}]*\}/gs) ?? [];
    const maxFunctionLength = funcMatches.reduce((max, fn) => Math.max(max, fn.split('\n').length), 0);

    const metrics: CodeMetrics = {
      linesOfCode: loc,
      linesOfComments: commentLines,
      blankLines,
      cyclomaticComplexity,
      cognitiveComplexity,
      maintainabilityIndex,
      duplicatedLines: 0, // Advanced: requires multi-file analysis
      functionCount,
      classCount: (content.match(/\bclass\s+\w+/g) ?? []).length,
      maxFunctionLength,
      maxNestingDepth: nestingDepth,
      commentRatio: loc > 0 ? Math.round((commentLines / loc) * 100) : 0,
    };

    // Collect issues
    const issues: QualityIssue[] = [];
    let issueId = 0;
    const mkId = () => `issue-${++issueId}`;

    // Complexity checks
    if (cyclomaticComplexity > 20) {
      issues.push({
        id: mkId(), severity: 'high', category: 'complexity',
        message: `Cyclomatic complexity is ${cyclomaticComplexity} (threshold: 20). Break this into smaller functions.`,
        filePath, rule: 'max-complexity',
        suggestion: 'Extract conditions into named helper functions.',
      });
    } else if (cyclomaticComplexity > 10) {
      issues.push({
        id: mkId(), severity: 'medium', category: 'complexity',
        message: `Cyclomatic complexity is ${cyclomaticComplexity} (moderate). Consider refactoring.`,
        filePath, rule: 'max-complexity',
      });
    }

    if (cognitiveComplexity > 30) {
      issues.push({
        id: mkId(), severity: 'high', category: 'maintainability',
        message: `Cognitive complexity is ${cognitiveComplexity}. This code is hard to understand.`,
        filePath, rule: 'cognitive-complexity',
        suggestion: 'Reduce nesting, extract methods, use early returns.',
      });
    }

    if (nestingDepth > 5) {
      issues.push({
        id: mkId(), severity: 'medium', category: 'maintainability',
        message: `Maximum nesting depth is ${nestingDepth} (recommended: ≤4). Use early returns or extract functions.`,
        filePath, rule: 'max-depth',
      });
    }

    if (maxFunctionLength > 100) {
      issues.push({
        id: mkId(), severity: 'medium', category: 'maintainability',
        message: `Longest function is ${maxFunctionLength} lines (recommended: ≤50).`,
        filePath, rule: 'max-lines-per-function',
        suggestion: 'Extract sub-functions for better readability and testability.',
      });
    }

    if (metrics.commentRatio < 5 && loc > 50) {
      issues.push({
        id: mkId(), severity: 'low', category: 'maintainability',
        message: `Low comment ratio (${metrics.commentRatio}%). Consider documenting complex logic.`,
        filePath, rule: 'min-comment-ratio',
      });
    }

    if (maintainabilityIndex < 20) {
      issues.push({
        id: mkId(), severity: 'high', category: 'maintainability',
        message: `Maintainability index is ${maintainabilityIndex}/100 (poor). Urgent refactoring needed.`,
        filePath, rule: 'maintainability-index',
      });
    }

    // Run linter if available
    const lintIssues = await this.runLinter(filePath, language);
    issues.push(...lintIssues);

    // Security scan
    const secResult = await this.securityScanner.scan(filePath, content);
    for (const vuln of secResult.vulnerabilities) {
      issues.push({
        id: mkId(),
        severity: vuln.severity,
        category: 'security',
        message: `[${vuln.cwe}] ${vuln.title}`,
        filePath,
        line: vuln.line,
        rule: vuln.cwe,
        suggestion: vuln.fix,
      });
    }

    const score = this.calculateScore(metrics, issues);
    const passed = score >= 60 && !issues.some(i => i.severity === 'critical');

    return {
      filePath, language, issues, metrics, passed, score,
      summary: this.buildSummary(score, issues, metrics),
    };
  }

  private async runLinter(filePath: string, language: string): Promise<QualityIssue[]> {
    const issues: QualityIssue[] = [];

    try {
      if ((language === 'typescript' || language === 'javascript') && filePath.endsWith('.ts')) {
        const result = await this.sandbox.execute('npx', ['eslint', '--format', 'json', filePath], {
          timeout: 15000,
          role: 'read-only',
          captureOutput: true,
        });
        if (result.stdout) {
          const eslintResults = JSON.parse(result.stdout) as Array<{
            messages: Array<{ ruleId: string; severity: number; message: string; line: number; column: number }>;
          }>;
          for (const file of eslintResults) {
            for (const msg of file.messages) {
              issues.push({
                id: `eslint-${msg.line}`,
                severity: msg.severity === 2 ? 'high' : 'medium',
                category: 'style',
                message: msg.message,
                filePath,
                line: msg.line,
                column: msg.column,
                rule: msg.ruleId ?? undefined,
              });
            }
          }
        }
      }
    } catch {
      // Linter not available — skip gracefully
      logger.debug('Linter not available, skipping', { filePath });
    }

    return issues;
  }

  private calculateScore(metrics: CodeMetrics, issues: QualityIssue[]): number {
    let score = 100;

    // Deduct for issues
    const deductions: Record<Severity, number> = { critical: 25, high: 15, medium: 8, low: 3, info: 1 };
    for (const issue of issues) score -= deductions[issue.severity] ?? 0;

    // Deduct for metrics
    if (metrics.cyclomaticComplexity > 20) score -= 15;
    else if (metrics.cyclomaticComplexity > 10) score -= 7;

    if (metrics.maintainabilityIndex < 20) score -= 15;
    else if (metrics.maintainabilityIndex < 50) score -= 7;

    if (metrics.maxNestingDepth > 5) score -= 10;
    if (metrics.maxFunctionLength > 100) score -= 8;

    return Math.max(0, Math.min(100, score));
  }

  private buildSummary(score: number, issues: QualityIssue[], metrics: CodeMetrics): string {
    const critical = issues.filter(i => i.severity === 'critical').length;
    const high = issues.filter(i => i.severity === 'high').length;
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

    return `Grade: ${grade} (${score}/100) | Issues: ${critical} critical, ${high} high | CC: ${metrics.cyclomaticComplexity} | MI: ${metrics.maintainabilityIndex}`;
  }

  private emptyReport(filePath: string, reason: string): QualityReport {
    return {
      filePath, language: detectLanguage(filePath), issues: [{
        id: 'unreadable', severity: 'info', category: 'bug',
        message: reason, filePath,
      }],
      metrics: {
        linesOfCode: 0, linesOfComments: 0, blankLines: 0,
        cyclomaticComplexity: 0, cognitiveComplexity: 0, maintainabilityIndex: 0,
        duplicatedLines: 0, functionCount: 0, classCount: 0,
        maxFunctionLength: 0, maxNestingDepth: 0, commentRatio: 0,
      },
      passed: false, score: 0, summary: reason,
    };
  }

  async analyzeProject(projectPath: string, files: string[]): Promise<{
    reports: QualityReport[];
    overall: { score: number; passed: boolean; totalIssues: number; criticalCount: number };
  }> {
    const reports = await Promise.all(
      files.slice(0, 100).map(f => this.analyze(f))
    );

    const scores = reports.map(r => r.score);
    const overall = {
      score: Math.round(scores.reduce((s, v) => s + v, 0) / (scores.length || 1)),
      passed: reports.every(r => r.passed),
      totalIssues: reports.reduce((s, r) => s + r.issues.length, 0),
      criticalCount: reports.reduce((s, r) => s + r.issues.filter(i => i.severity === 'critical').length, 0),
    };

    return { reports, overall };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _gate: QualityGate | null = null;

export function getQualityGate(): QualityGate {
  if (!_gate) _gate = new QualityGate();
  return _gate;
}

export default getQualityGate;
