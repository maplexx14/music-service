$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$videoStory = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'story.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$videoVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $videoVoice.SelectVoice('Microsoft Irina Desktop')
    $videoVoice.Rate = 1
    $videoVoice.Volume = 100
    for ($videoIndex = 0; $videoIndex -lt $videoStory.hook.Count; $videoIndex++) {
        $videoWav = Join-Path $PSScriptRoot ("assets\line-{0}.wav" -f $videoIndex)
        $videoVoice.SetOutputToWaveFile($videoWav)
        $videoVoice.Speak([string]$videoStory.hook[$videoIndex])
        $videoVoice.SetOutputToNull()
    }
    $videoVoice.SetOutputToWaveFile((Join-Path $PSScriptRoot 'assets\reveal.wav'))
    $videoVoice.Speak([string]$videoStory.reveal)
    $videoVoice.SetOutputToNull()
} finally {
    $videoVoice.Dispose()
}
Write-Output 'Narration rendered with the installed Russian voice.'
