import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleDeployAnnounce } from '../src/lib/announce.ts'
import { postAnnounceCp } from '../src/lib/cp.ts'

const env = {
  BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN: 'secret',
  BLOCKFIELD_CP_URL: 'http://cp',
  BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
  BLOCKFIELD_CP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
}
const post = (token) =>
  new Request('http://site/api/deploy-announce', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

test('deploy announce triggers only the fixed CP notice and only with the token', async () => {
  let sent = 0
  const send = async () => {
    sent++
  }
  assert.equal((await handleDeployAnnounce(post('wrong'), env, send)).status, 401)
  assert.equal((await handleDeployAnnounce(post(), env, send)).status, 401)
  for (const missing of ['BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN', 'BLOCKFIELD_CP_MODERATION_TOKEN'])
    assert.equal(
      (await handleDeployAnnounce(post('secret'), { ...env, [missing]: '' }, send)).status,
      503,
    )
  assert.equal(
    (await handleDeployAnnounce(new Request('http://site/api/deploy-announce'), env, send)).status,
    405,
  )
  assert.equal(sent, 0)
  assert.equal((await handleDeployAnnounce(post('secret'), env, send)).status, 200)
  assert.equal(sent, 1)
  assert.equal(
    (
      await handleDeployAnnounce(post('secret'), env, async () => {
        throw new Error('down')
      })
    ).status,
    502,
  )
})

test('postAnnounceCp sends no actor and no text: the game holds the notice', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, env)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body), init.headers.Authorization])
    return Response.json({ operationId: 'op-a', status: 'accepted' }, { status: 202 })
  }
  assert.deepEqual(await postAnnounceCp({ idempotencyKey: 'k', fetchImpl }), {
    operationId: 'op-a',
  })
  const [[url, body, auth]] = calls
  assert.equal(url, 'http://cp/v2/actions/moderation.announce')
  assert.equal(auth, 'Bearer mod-t')
  assert.deepEqual(Object.keys(body).sort(), [
    'backend',
    'consumerId',
    'environment',
    'generation',
    'idempotencyKey',
    'target',
  ])
})
