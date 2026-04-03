/**
 * AetherDev — Git Integration Utility
 * Branch management, conventional commits, PR generation, diff analysis
 */

import simpleGit, { SimpleGit, StatusResult, DiffResult, LogResult } from 'simple-git';
import * as path from 'path';
import { getConfig } from '../config/index.js';
import { getLogger, formatError } from './logger.js';

const logger = getLogger('git');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  date: string;
  message: string;
  author: string;
  email: string;
}

export interface BranchInfo {
  current: string;
  all: string[];
  local: string[];
  remote: string[];
}

export interface RepoStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isClean: boolean;
  ahead: number;
  behind: number;
}

export interface ConventionalCommit {
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'perf' | 'ci' | 'build';
  scope?: string;
  description: string;
  body?: string;
  footer?: string;
  breaking?: boolean;
}

export interface PRTemplate {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
}

// ─── Git Manager ──────────────────────────────────────────────────────────────

export class GitManager {
  private readonly git: SimpleGit;
  private readonly repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = path.resolve(repoPath);
    this.git = simpleGit(this.repoPath);
    this.configure();
  }

  private configure(): void {
    const cfg = getConfig();
    this.git.addConfig('user.name', cfg.gitUserName, false, 'local').catch(() => {});
    this.git.addConfig('user.email', cfg.gitUserEmail, false, 'local').catch(() => {});
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  async init(initialBranch: string = 'main'): Promise<void> {
    await this.git.init();
    await this.git.checkoutLocalBranch(initialBranch);
    logger.info(`Git repo initialized with branch: ${initialBranch}`);
  }

  async getStatus(): Promise<RepoStatus> {
    const status: StatusResult = await this.git.status();
    const log = await this.git.log(['--oneline', '-1']).catch(() => null);

    return {
      branch: status.current ?? 'unknown',
      staged: status.staged,
      unstaged: [...status.modified, ...status.deleted].filter(f => !status.staged.includes(f)),
      untracked: status.not_added,
      isClean: status.isClean(),
      ahead: status.ahead,
      behind: status.behind,
    };
  }

  async getBranches(): Promise<BranchInfo> {
    const branches = await this.git.branch(['-a']);
    const local = branches.all.filter(b => !b.startsWith('remotes/'));
    const remote = branches.all
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace('remotes/', ''));

    return {
      current: branches.current,
      all: branches.all,
      local,
      remote,
    };
  }

  async createBranch(name: string, fromBranch?: string): Promise<void> {
    const branchName = name.replace(/[^a-z0-9-_/]/gi, '-').toLowerCase();
    if (fromBranch) {
      await this.git.checkoutBranch(branchName, fromBranch);
    } else {
      await this.git.checkoutLocalBranch(branchName);
    }
    logger.info(`Branch created: ${branchName}`);
  }

  async switchBranch(name: string): Promise<void> {
    await this.git.checkout(name);
    logger.info(`Switched to branch: ${name}`);
  }

  async deleteBranch(name: string, force: boolean = false): Promise<void> {
    await this.git.deleteLocalBranch(name, force);
    logger.info(`Branch deleted: ${name}`);
  }

  async stageFiles(files: string[]): Promise<void> {
    await this.git.add(files);
    logger.debug(`Staged files: ${files.join(', ')}`);
  }

  async stageAll(): Promise<void> {
    await this.git.add('.');
    logger.debug('Staged all files');
  }

  async commit(message: string | ConventionalCommit): Promise<string> {
    const commitMessage = typeof message === 'string'
      ? message
      : this.formatConventionalCommit(message);

    const result = await this.git.commit(commitMessage);
    logger.info(`Committed: ${result.commit}`, { message: commitMessage });
    return result.commit;
  }

  async amendLastCommit(newMessage?: string): Promise<void> {
    const args = ['--amend', '--no-edit'];
    if (newMessage) args.push('-m', newMessage);
    await this.git.raw(['commit', ...args]);
    logger.info('Last commit amended');
  }

  async getLog(maxCount: number = 20, branch?: string): Promise<CommitInfo[]> {
    const options: string[] = [`--max-count=${maxCount}`, '--format=%H|%ai|%s|%an|%ae'];
    if (branch) options.push(branch);

    const result: LogResult = await this.git.log(options);
    return result.all.map(entry => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
      email: entry.author_email,
    }));
  }

  async getDiff(
    base?: string,
    head?: string,
    options: { staged?: boolean; stat?: boolean } = {}
  ): Promise<string> {
    const args: string[] = [];
    if (options.staged) args.push('--staged');
    if (options.stat) args.push('--stat');
    if (base && head) args.push(base, head);
    else if (base) args.push(base);

    return this.git.diff(args);
  }

  async getDiffStat(base: string = 'HEAD~1'): Promise<string> {
    return this.getDiff(base, undefined, { stat: true });
  }

  async getChangedFiles(base: string = 'HEAD'): Promise<string[]> {
    const diff = await this.git.diff(['--name-only', base]);
    return diff.split('\n').filter(Boolean);
  }

  async pull(remote: string = 'origin', branch?: string): Promise<void> {
    const args = branch ? [remote, branch] : [remote];
    await this.git.pull(remote, branch);
    logger.info(`Pulled from ${remote}${branch ? `/${branch}` : ''}`);
  }

  async push(remote: string = 'origin', branch?: string, force: boolean = false): Promise<void> {
    const opts: string[] = [];
    if (force) opts.push('--force-with-lease'); // safer than --force
    if (branch) {
      await this.git.push(remote, branch, opts);
    } else {
      await this.git.push(remote, opts);
    }
    logger.info(`Pushed to ${remote}`);
  }

  async fetch(remote: string = 'origin'): Promise<void> {
    await this.git.fetch(remote);
    logger.debug(`Fetched from ${remote}`);
  }

  async stash(message?: string): Promise<void> {
    const args = message ? ['push', '-m', message] : [];
    await this.git.stash(args);
    logger.info('Changes stashed');
  }

  async stashPop(): Promise<void> {
    await this.git.stash(['pop']);
    logger.info('Stash popped');
  }

  async merge(branch: string, noFastForward: boolean = true): Promise<void> {
    const args = noFastForward ? ['--no-ff', branch] : [branch];
    await this.git.merge(args);
    logger.info(`Merged branch: ${branch}`);
  }

  async rebase(onto: string): Promise<void> {
    await this.git.rebase([onto]);
    logger.info(`Rebased onto: ${onto}`);
  }

  async tag(name: string, message?: string): Promise<void> {
    if (message) {
      await this.git.addAnnotatedTag(name, message);
    } else {
      await this.git.addTag(name);
    }
    logger.info(`Tag created: ${name}`);
  }

  async getRemotes(): Promise<Array<{ name: string; url: string }>> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map(r => ({ name: r.name, url: r.refs.fetch }));
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
    logger.info(`Remote added: ${name} → ${url}`);
  }

  // ─── PR Generation ──────────────────────────────────────────────────────────

  async generatePRTemplate(baseBranch: string = 'main'): Promise<PRTemplate> {
    const status = await this.getStatus();
    const currentBranch = status.branch;
    const diff = await this.getDiffStat(baseBranch);
    const commits = await this.getLog(20, `${baseBranch}..${currentBranch}`);

    const title = this.inferPRTitle(currentBranch, commits);
    const body = this.buildPRBody(commits, diff);
    const labels = this.inferLabels(commits);

    return {
      title,
      body,
      baseBranch,
      headBranch: currentBranch,
      labels,
    };
  }

  private inferPRTitle(branch: string, commits: CommitInfo[]): string {
    if (commits.length === 1) return commits[0]!.message;
    // Parse branch name: feat/user-auth → feat: user auth
    const branchMatch = branch.match(/^(feat|fix|docs|refactor|test|chore|perf)\/(.+)$/);
    if (branchMatch) {
      const type = branchMatch[1]!;
      const desc = branchMatch[2]!.replace(/-/g, ' ');
      return `${type}: ${desc}`;
    }
    return branch.replace(/-/g, ' ');
  }

  private buildPRBody(commits: CommitInfo[], diffStat: string): string {
    const commitList = commits.map(c => `- ${c.message} (${c.hash.slice(0, 7)})`).join('\n');
    return [
      '## Summary',
      '',
      '<!-- Describe what this PR does and why -->',
      '',
      '## Changes',
      '',
      commitList,
      '',
      '## Diff Stats',
      '',
      '```',
      diffStat.trim(),
      '```',
      '',
      '## Testing',
      '',
      '- [ ] Unit tests pass',
      '- [ ] Integration tests pass',
      '- [ ] Manual testing done',
      '',
      '## Checklist',
      '',
      '- [ ] Code follows project conventions',
      '- [ ] Documentation updated',
      '- [ ] No breaking changes (or documented)',
      '',
      '---',
      '*Generated by AetherDev*',
    ].join('\n');
  }

  private inferLabels(commits: CommitInfo[]): string[] {
    const labels = new Set<string>();
    commits.forEach(c => {
      const m = c.message.match(/^(feat|fix|docs|refactor|test|chore|perf|ci)/);
      if (m) {
        const map: Record<string, string> = {
          feat: 'enhancement', fix: 'bug', docs: 'documentation',
          refactor: 'refactor', test: 'testing', chore: 'chore',
          perf: 'performance', ci: 'ci',
        };
        const label = map[m[1]!];
        if (label) labels.add(label);
      }
    });
    return Array.from(labels);
  }

  // ─── Conventional Commits ────────────────────────────────────────────────────

  formatConventionalCommit(commit: ConventionalCommit): string {
    const scope = commit.scope ? `(${commit.scope})` : '';
    const breaking = commit.breaking ? '!' : '';
    let message = `${commit.type}${scope}${breaking}: ${commit.description}`;
    if (commit.body) message += `\n\n${commit.body}`;
    if (commit.footer) message += `\n\n${commit.footer}`;
    if (commit.breaking) message += `\n\nBREAKING CHANGE: ${commit.description}`;
    return message;
  }

  suggestCommitType(filesChanged: string[]): ConventionalCommit['type'] {
    const testFiles = filesChanged.filter(f => f.includes('test') || f.includes('spec'));
    const docFiles = filesChanged.filter(f => f.includes('doc') || f.endsWith('.md'));
    const ciFiles = filesChanged.filter(f => f.includes('.github') || f.includes('ci'));

    if (ciFiles.length > 0) return 'ci';
    if (testFiles.length === filesChanged.length) return 'test';
    if (docFiles.length === filesChanged.length) return 'docs';
    return 'feat';
  }

  async generateAutoCommitMessage(stagedFiles: string[]): Promise<ConventionalCommit> {
    const diff = await this.getDiff(undefined, undefined, { staged: true });
    const type = this.suggestCommitType(stagedFiles);

    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));

    const scope = stagedFiles.length === 1
      ? path.basename(stagedFiles[0]!, path.extname(stagedFiles[0]!))
      : undefined;

    const description = addedLines.length > removedLines.length
      ? `add ${stagedFiles.length} file(s)`
      : `update ${stagedFiles.length} file(s)`;

    return { type, scope, description };
  }

  async clone(url: string, targetDir: string): Promise<void> {
    await this.git.clone(url, targetDir);
    logger.info(`Cloned ${url} → ${targetDir}`);
  }
}

// ─── Singleton Factory ────────────────────────────────────────────────────────

const instances = new Map<string, GitManager>();

export function getGitManager(repoPath: string = process.cwd()): GitManager {
  const key = path.resolve(repoPath);
  if (!instances.has(key)) {
    instances.set(key, new GitManager(key));
  }
  return instances.get(key)!;
}

export default getGitManager;
