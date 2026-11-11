$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
public class NeutralWord {
    public string text;
    public int character;
    public double start;
}
public static class NeutralNarration {
    public static List<NeutralWord> Render(string text, string file, string voice) {
        var words = new List<NeutralWord>();
        using (var synth = new SpeechSynthesizer()) {
            synth.SelectVoice(voice);
            synth.Rate = 1;
            synth.Volume = 100;
            synth.SpeakProgress += (sender, e) => {
                words.Add(new NeutralWord { text = e.Text, character = e.CharacterPosition, start = e.AudioPosition.TotalSeconds });
            };
            synth.SetOutputToWaveFile(file, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.Speak(text);
            synth.SetOutputToNull();
        }
        return words;
    }
}
'@
$neutralStory = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'neutral-story.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$neutralResults = @()
for ($neutralIndex = 0; $neutralIndex -lt $neutralStory.segments.Count; $neutralIndex++) {
    $neutralSegment = $neutralStory.segments[$neutralIndex]
    $neutralFile = Join-Path $PSScriptRoot ("assets\neutral-line-{0}.wav" -f $neutralIndex)
    $neutralWords = [NeutralNarration]::Render($neutralSegment.text, $neutralFile, $neutralStory.voice)
    $neutralResults += [PSCustomObject]@{ text = $neutralSegment.text; words = @($neutralWords) }
}
$neutralJson = ConvertTo-Json -InputObject $neutralResults -Depth 8
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'assets/neutral-speech-timing.json'), $neutralJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Neutral narration and word timings generated.'
