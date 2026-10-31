import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-same-tree.sh')

// Fake `gh`: answers the API calls ci-same-tree.sh makes using COMMIT_TREE and
// ARTIFACT_NAMES from the environment, so no network is needed.
const fakeGh = `#!/bin/sh
args="$*"
case "$args" in
  *"/runs?status=success"*) printf 'abc123\\n' ;;
  *"/git/commits/"*) printf '%s\\n' "\${COMMIT_TREE:-other}" ;;
  *"?event=pull_request"*) printf '42\\n' ;;
  *"/artifacts"*) printf '%s\\n' "\${ARTIFACT_NAMES:-unrelated}" ;;
esac
`

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-same-tree-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'file.txt'), 'content\n')
  await exec('git', ['-C', repo, 'add', 'file.txt'])
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.email=test@blockfield.pro',
    '-c',
    'user.name=test',
    'commit',
    '-qm',
    'fixture',
  ])
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), fakeGh)
  await chmod(join(bin, 'gh'), 0o755)
  const tree = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'])).stdout.trim()
  return {
    repo,
    tree,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'Blockfield/blockfield-site',
    },
  }
}

async function lookup(repo, env) {
  return await exec('sh', [script, 'standards.yml'], { cwd: repo, env })
}

test('matching head tree reports tested', async (t) => {
  const { repo, tree, env } = await setup(t)
  const result = await lookup(repo, { ...env, COMMIT_TREE: tree })
  assert.equal(result.stdout.trim(), 'true')
})

test('matching tested-tree artifact reports tested', async (t) => {
  const { repo, tree, env } = await setup(t)
  const result = await lookup(repo, {
    ...env,
    COMMIT_TREE: 'no-match',
    ARTIFACT_NAMES: `tested-tree-${tree}`,
  })
  assert.equal(result.stdout.trim(), 'true')
})

test('unknown tree reports untested', async (t) => {
  const { repo, env } = await setup(t)
  const result = await lookup(repo, { ...env, COMMIT_TREE: 'no-match' })
  assert.equal(result.stdout.trim(), 'false')
})

test('missing workflow argument fails closed', async (t) => {
  const { repo, env } = await setup(t)
  await assert.rejects(exec('sh', [script], { cwd: repo, env }))
})
