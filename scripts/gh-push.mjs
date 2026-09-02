/**
 * 无需 git push 的 GitHub 发布脚本
 * ---------------------------------------------------------------
 * 为什么存在：部分机器上的 Git for Windows 安装不完整（缺少
 * git-pack-objects / git-send-pack / git-remote-https 等组件），导致
 * `git push` 直接崩溃。此脚本改用 GitHub Git Data API（经 gh CLI 的
 * 已登录令牌）把本地提交历史逐对象搬到远端，内容与本地字节级一致。
 *
 * 前提：已安装并登录 gh CLI（gh auth status 显示 Logged in + repo 权限），
 *       且 Git 至少能执行本地命令（init/add/commit/log）。
 *
 * 用法（在仓库根目录）：
 *   node scripts/gh-push.mjs [远端仓库名]
 *   例如：node scripts/gh-push.mjs              # 默认 BBQMARTE/bili-all-up-update-dot
 *
 * 机制：
 *   1. git rev-list --reverse HEAD 列出全部本地提交（从旧到新）
 *   2. 逐条提交：git cat-file 读取 tree/author/committer/message，
 *      内容对象经 git cat-file blob 导出（保证内容寻址哈希一致）
 *   3. POST /git/blobs → /git/trees → /git/commits 逐级创建
 *   4. 最后把 refs/heads/main 指向最新提交（已存在则 force 更新）
 */
import { spawnSync } from 'node:child_process';

const REPO = process.argv[2] || 'BBQMARTE/bili-all-up-update-dot';
const REPO_DIR = process.cwd();
const GIT = 'git';

function run(args) {
  const r = spawnSync(GIT, args, { encoding: 'buffer', cwd: REPO_DIR });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} exit ${r.status}\n${(r.stderr || '').toString().slice(0, 500)}`);
  }
  return r.stdout;
}

function gh(endpoint, method, payload) {
  const r = spawnSync('gh', ['api', `repos/${REPO}/${endpoint}`, '-X', method, '--input', '-'], {
    input: payload ? JSON.stringify(payload) : '',
    encoding: 'utf8',
  });
  let body = null;
  try {
    body = JSON.parse(r.stdout || '{}');
  } catch (e) {}
  if (r.status !== 0) {
    throw new Error(`${endpoint}: ${(body && body.message) || r.stderr || 'gh api failed'}`);
  }
  return body;
}

function parseIdent(line) {
  const m = line.match(/^(author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error('bad ident line: ' + line);
  return { name: m[2], email: m[3], date: new Date(Number(m[4]) * 1000).toISOString() };
}

// 检查 gh 是否已登录
{
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('gh 未登录，请先执行 gh auth login');
    process.exit(1);
  }
}

const shas = run(['rev-list', '--reverse', 'HEAD'])
  .toString('utf8')
  .trim()
  .split('\n')
  .filter(Boolean);
console.log(`local commits: ${shas.length}`);

// 空仓库兼容：Git Data API 对完全空的仓库返回 409，先写入 README 制造初始提交
{
  const r = spawnSync('gh', ['api', `repos/${REPO}/commits/main`], { encoding: 'utf8' });
  if (r.status !== 0) {
    const tree = run(['rev-parse', `${shas[0]}^{tree}`]).toString('utf8').trim();
    const m = run(['ls-tree', tree, 'README.md']).toString('utf8').match(/([0-9a-f]{40})/);
    const content = m
      ? run(['cat-file', 'blob', m[1]]).toString('base64')
      : Buffer.from('# init\n').toString('base64');
    gh('contents/README.md', 'PUT', { message: 'init', content });
    console.log('repo initialized (temp commit, will be orphaned)');
  }
}

const blobCache = new Map();
let parentSha = null;
let mismatch = 0;

for (let i = 0; i < shas.length; i++) {
  const sha = shas[i];
  const raw = run(['cat-file', 'commit', sha]).toString('utf8');
  const treeSha = run(['rev-parse', `${sha}^{tree}`]).toString('utf8').trim();
  const entries = run(['ls-tree', '-r', sha])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/);
      if (!m) throw new Error('bad ls-tree line: ' + line);
      return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
    });

  for (const e of entries) {
    if (blobCache.has(e.sha)) continue;
    const content = run(['cat-file', 'blob', e.sha]).toString('base64');
    const blob = gh('git/blobs', 'POST', { content, encoding: 'base64' });
    if (blob.sha !== e.sha) throw new Error(`blob mismatch: ${e.path}`);
    blobCache.set(e.sha, blob.sha);
  }

  const tree = gh('git/trees', 'POST', {
    tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
  });
  if (tree.sha !== treeSha) {
    console.log(`  ! commit ${i + 1}: tree hash differs (content identical)`);
    mismatch++;
  }

  const authorLine = raw.split('\n').find((l) => l.startsWith('author '));
  const committerLine = raw.split('\n').find((l) => l.startsWith('committer '));
  const message = raw.slice(raw.indexOf('\n\n') + 2).replace(/\n$/, '');
  const commit = gh('git/commits', 'POST', {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
    author: parseIdent(authorLine),
    committer: parseIdent(committerLine),
  });
  parentSha = commit.sha;
  console.log(`  [${i + 1}/${shas.length}] ${sha.slice(0, 8)} -> ${commit.sha.slice(0, 8)}  ${message.split('\n')[0]}`);
}

try {
  gh('git/refs', 'POST', { ref: 'refs/heads/main', sha: parentSha });
  console.log('created refs/heads/main');
} catch (e) {
  gh('git/refs/heads/main', 'PATCH', { sha: parentSha, force: true });
  console.log('force-updated refs/heads/main');
}

console.log(`\ndone: https://github.com/${REPO}`);
console.log(`blobs: ${blobCache.size}, tree mismatches: ${mismatch}`);
