import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleDeployAnnounce, RESTART_NOTICE } from '../src/lib/announce.ts'

const env = {
  BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN: 'secret',
  BLOCKFIELD_RCON_HOST: 'game',
  BLOCKFIELD_RCON_PASSWORD: 'pw',
}
const post = (token) =>
  new Request('http://site/api/deploy-announce', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

test('deploy announce sends only the fixed notice and only with the token', async () => {
  const sent = []
  const send = async (commands) => {
    sent.push(...commands)
    return ['']
  }
  assert.equal((await handleDeployAnnounce(post('wrong'), env, send)).status, 401)
  assert.equal((await handleDeployAnnounce(post(), env, send)).status, 401)
  assert.equal(
    (
      await handleDeployAnnounce(
        post('secret'),
        { ...env, BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN: '' },
        send,
      )
    ).status,
    503,
  )
  assert.equal(
    (await handleDeployAnnounce(new Request('http://site/api/deploy-announce'), env, send)).status,
    405,
  )
  assert.deepEqual(sent, [])
  assert.equal((await handleDeployAnnounce(post('secret'), env, send)).status, 200)
  assert.deepEqual(sent, [RESTART_NOTICE])
  assert.equal(
    (
      await handleDeployAnnounce(post('secret'), env, async () => {
        throw new Error('down')
      })
    ).status,
    502,
  )
})
