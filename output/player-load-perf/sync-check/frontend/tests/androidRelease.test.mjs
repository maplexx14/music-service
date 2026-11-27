import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  androidDownloadUrl,
  installedAndroidVersion,
  isAndroidReleaseClient,
  isAndroidUpdateAvailable,
  parseAndroidRelease,
  shouldShowAndroidRelease,
} from '../src/services/androidRelease.js'

const android = 'Mozilla/5.0 (Linux; Android 15; vivo) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'
const release = { versionCode: 6, versionName: '1.5', notes: 'Исправлено переключение треков.' }

test('Android browsers, PWA and APKs can receive the site notice', () => {
  assert.equal(isAndroidReleaseClient(android), true)
  assert.equal(isAndroidReleaseClient(android.replace('Chrome/130.0', 'SamsungBrowser/27.0')), true)
  assert.equal(isAndroidReleaseClient(`${android} BoltAndroid/1.4`), true)
  assert.equal(isAndroidReleaseClient(`${android} BoltAndroid/1.5`), true)
  assert.equal(isAndroidReleaseClient('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), false)
  assert.equal(isAndroidReleaseClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false)
})

test('older APKs receive updates while the installed and newer versions remain quiet', () => {
  const published = { ...release, versionCode: 7, versionName: '1.6' }
  for (const version of ['1.0', '1.4', '1.5']) {
    const ua = `${android} BoltAndroid/${version}`
    assert.equal(shouldShowAndroidRelease(published, 0, installedAndroidVersion(ua)), true)
    assert.equal(shouldShowAndroidRelease(published, 6, installedAndroidVersion(ua)), true)
    assert.equal(shouldShowAndroidRelease(published, 7, installedAndroidVersion(ua)), false)
  }
  for (const version of ['1.6', '1.6.0', '1.7', '1.10', '2.0']) {
    assert.equal(shouldShowAndroidRelease(published, 0, installedAndroidVersion(`${android} BoltAndroid/${version}`)), false)
  }
  assert.equal(shouldShowAndroidRelease(published, 0, installedAndroidVersion(android)), true)
})

test('APK version comparison is numeric and accepts only known numeric versions', () => {
  assert.equal(isAndroidUpdateAvailable({ ...release, versionName: '1.10' }, '1.9'), true)
  assert.equal(isAndroidUpdateAvailable({ ...release, versionName: '1.6.1' }, '1.6'), true)
  assert.equal(isAndroidUpdateAvailable({ ...release, versionName: '1.6' }, '1.6.0'), false)
  assert.equal(isAndroidUpdateAvailable(null, '1.4'), false)
  assert.equal(isAndroidUpdateAvailable(release, null), false)
  assert.equal(isAndroidUpdateAvailable(release, 'unknown'), false)
  assert.equal(isAndroidUpdateAvailable({ ...release, versionName: 'invalid' }, '1.4'), false)
})

test('dismissing one release allows the next release and suppresses older releases', () => {
  assert.equal(shouldShowAndroidRelease(release, 0), true)
  assert.equal(shouldShowAndroidRelease(release, 6), false)
  assert.equal(shouldShowAndroidRelease(release, 7), false)
  assert.equal(shouldShowAndroidRelease({ ...release, versionCode: 7 }, 6), true)
  assert.equal(shouldShowAndroidRelease(null, 0), false)
})

test('invalid version manifests cannot trigger an update announcement', () => {
  for (const value of [null, {}, { ...release, versionCode: 0 }, { ...release, versionCode: -1 },
    { ...release, versionCode: 6.5 }, { ...release, versionCode: '6' }, { ...release, versionName: ' ' }]) {
    assert.equal(parseAndroidRelease(value), null)
  }
  assert.deepEqual(parseAndroidRelease({ versionCode: 6, versionName: ' 1.5 ' }), { ...release, notes: '' })
})

test('published manifest supplies the release shown on the site', async () => {
  const published = JSON.parse(await readFile(new URL('../public/bolt-version.json', import.meta.url), 'utf8'))
  const parsed = parseAndroidRelease(published)
  assert.ok(parsed)
  assert.equal(parsed.versionCode, published.versionCode)
  assert.equal(parsed.versionName, published.versionName)
})

test('download uses a version query and keeps the stable native updater URL', () => {
  assert.equal(androidDownloadUrl(release), '/bolt.apk?v=6')
  assert.equal(androidDownloadUrl({ ...release, versionCode: 7 }), '/bolt.apk?v=7')
  assert.equal(androidDownloadUrl(null), '/bolt.apk')
})

test('downloads inside old APKs open a browser instead of returning through an App Link', () => {
  assert.equal(androidDownloadUrl(release, 'https://boltmusic.lat'),
    'intent://boltmusic.lat/bolt.apk?v=6#Intent;scheme=https;type=text/html;end')
  assert.equal(androidDownloadUrl(null, 'https://boltmusic.lat'),
    'intent://boltmusic.lat/bolt.apk#Intent;scheme=https;type=text/html;end')
})

test('settings report the installed APK version without treating a browser as an APK', () => {
  assert.equal(installedAndroidVersion(`${android} BoltAndroid/1.5`), '1.5')
  assert.equal(installedAndroidVersion(android), null)
})
