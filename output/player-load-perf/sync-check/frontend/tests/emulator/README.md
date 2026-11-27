# Android playback probes

`probe.mjs` mounts the real current-source Player, store and audio engine in a
logged-out disposable debug APK. Account layout/lifecycle and write telemetry
are excluded. Only `emulator-*` devices are accepted. `observe` disconnects CDP,
removes the ADB forward, and makes no device calls until the observation ends.

See `android/README.md` for SDK setup, public-track tests and power-state cleanup.

## Deterministic mid-track failure

`fixtureServer.mjs` serves an eight-minute WAV over HTTPS. For each unique `run`,
the first response sends 20 seconds of audio then leaves the connection open
without further bytes or EOF. Subsequent requests support HTTP ranges and return
the remaining audio. This exercises real buffering and recovery, not a mock pause.
Server requests are saved to `android/app/build/reports/background-playback/fixture/requests.jsonl`.

The test uses a separate debug build of the 1.8 shell from commit `7c96ace`. Its
only addition is a certificate trusted for `10.0.2.2` in **that disposable APK**.
Production Android sources, system trust, and public release artifacts are not
modified. Prerequisites: the configured Android SDK/JDK and OpenSSL (Git for Windows
includes it at `C:\Program Files\Git\usr\bin\openssl.exe`).

From the repository root, prepare the test shell and certificate:

```powershell
$fixture = Join-Path (Get-Location) 'android\app\build\reports\background-playback\fixture'
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
git archive --format=zip --output="$fixture\shell-1.8.zip" 7c96ace android
Expand-Archive -LiteralPath "$fixture\shell-1.8.zip" -DestinationPath "$fixture\shell-1.8" -Force
& 'C:\Program Files\Git\usr\bin\openssl.exe' req -x509 -newkey rsa:2048 -nodes -keyout "$fixture\localhost.key" -out "$fixture\localhost.pem" -days 2 -subj '/CN=Bolt emulator stream fixture' -addext 'subjectAltName=IP:10.0.2.2,IP:127.0.0.1'
$debug = "$fixture\shell-1.8\android\app\src\debug"
New-Item -ItemType Directory -Force -Path "$debug\res\raw", "$debug\res\xml" | Out-Null
Copy-Item -LiteralPath "$fixture\localhost.pem" -Destination "$debug\res\raw\fixture_ca.pem"
Set-Content -Encoding UTF8 -LiteralPath "$debug\AndroidManifest.xml" -Value '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/fixture_network_security" /></manifest>'
Set-Content -Encoding UTF8 -LiteralPath "$debug\res\xml\fixture_network_security.xml" -Value '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config><domain-config><domain>10.0.2.2</domain><trust-anchors><certificates src="@raw/fixture_ca" /></trust-anchors></domain-config></network-security-config>'
Copy-Item -LiteralPath 'android\local.properties' -Destination "$fixture\shell-1.8\android\local.properties"
$env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
$env:ANDROID_HOME = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
Push-Location "$fixture\shell-1.8\android"
.\gradlew.bat assembleDebug
Pop-Location
& "$env:ANDROID_HOME\platform-tools\adb.exe" -s emulator-5554 install -r -d "$fixture\shell-1.8\android\app\build\outputs\apk\debug\app-debug.apk"
```

Regenerate and rebuild when the two-day certificate expires. Start the server
from `frontend` with `node tests/emulator/fixtureServer.mjs` and leave it running.
After installation, let the emulator settle before launching playback; a pending
package update can recreate the Activity and invalidate the probe.

From another terminal in `frontend`, with the APK open on its login page:

```powershell
# Baseline: set this only for the control run.
$env:BOLT_BASELINE_REF = '7c96ace'
node tests/emulator/probe.mjs start-fixture baseline-unique-name
& "$env:ANDROID_HOME\platform-tools\adb.exe" -s emulator-5554 shell dumpsys battery unplug
& "$env:ANDROID_HOME\platform-tools\adb.exe" -s emulator-5554 shell input keyevent 223
Start-Sleep -Seconds 2
node tests/emulator/probe.mjs observe baseline-unique-name 75
node tests/emulator/probe.mjs analyze baseline-unique-name

# Restart the APK and unlock the emulator before the fixed run.
Remove-Item Env:BOLT_BASELINE_REF
node tests/emulator/probe.mjs start-fixture fixed-unique-name
& "$env:ANDROID_HOME\platform-tools\adb.exe" -s emulator-5554 shell input keyevent 223
Start-Sleep -Seconds 2
node tests/emulator/probe.mjs observe fixed-unique-name 380
node tests/emulator/probe.mjs analyze fixed-unique-name
```

Use a new run name for each failure injection. Expected baseline: position stops
near 19 seconds, no media error, `playbackState=playing` but `stillAdvancing=false`.
Expected fix: `recovery:stall` in diagnostics, a new range request, position
restored, then sustained hidden progress. Pause/cancel/track-switch cases are
covered by the real Player-effect regressions in `androidPlayback.test.mjs`.

An AOSP emulator does not establish how Samsung One UI battery restrictions behave.
With `-no-audio`, these probes verify media progress and the Android audio track,
not acoustic output. They also do not exercise the authenticated account layout.

## Full account UI audit

`uiAudit.mjs` serves `frontend/dist` inside the installed debug APK WebView.
The API, Turnstile captcha, email verification, covers and audio use the live
service. Build the frontend first, open the APK, then run from `frontend`:

```powershell
npm run build
node tests/emulator/uiAudit.mjs serve
```

The server listens on localhost port 9234 and forwards CDP on 9223. From a
second terminal, inspect the current screen or save an Android screenshot:

```powershell
node tests/emulator/uiAudit.mjs summary
node tests/emulator/uiAudit.mjs screenshot home
node tests/emulator/uiAudit.mjs navigate /playlists
node tests/emulator/uiAudit.mjs eval --file expression.js
```

Use `eval --file` for expressions containing quotes in PowerShell. `tap` uses
real ADB input at the element coordinates. Run scenarios sequentially against
one emulator. Check that the keyboard is visible before sending native Back
to dismiss it; otherwise Back navigates the app. Loading `/` in the APK restores
the last tab, so use the Home navigation button to test the main screen.

Commands also support JSON `rule` request failures/delays, `clear-rules`,
`offline true/false`, `cdp`, `record` and `report`. Snapshots and network traces
are saved under ignored `android/app/build/reports/ui-audit`. Inspect does not
include input values, and token parameters in network URLs are redacted.
Keep test account credentials in ignored files. Disconnect CDP before judging
background playback and reset any screen-size or network overrides after tests.
