import assert from 'node:assert/strict'
import test from 'node:test'
import { registerAppServiceWorker } from '../src/services/serviceWorker.js'

test('HTTP localhost and HTTPS register automatically in a secure context', async () => {
  for (const protocol of ['http:', 'https:']) {
    let called = 0
    const registration = { scope: '/' }
    const result = await registerAppServiceWorker({ isSecureContext: true, location: { protocol } }, {
      serviceWorker: { register: async (path, options) => {
        called++
        assert.equal(path, '/sw.js')
        assert.equal(options.updateViaCache, 'none')
        return registration
      } },
    })
    assert.equal(called, 1)
    assert.equal(result, registration)
  }
})

test('insecure origins and unsupported browsers do not attempt registration', async () => {
  const browser = { serviceWorker: { register: () => { throw new Error('Must not be called') } } }
  assert.equal(await registerAppServiceWorker({ isSecureContext: false }, browser), null)
  assert.equal(await registerAppServiceWorker({ isSecureContext: true }, {}), null)
})

test('registration errors do not interrupt startup', async () => {
  assert.equal(await registerAppServiceWorker({ isSecureContext: true }, {
    serviceWorker: { register: async () => { throw new Error('Storage disabled') } },
  }), null)
})
