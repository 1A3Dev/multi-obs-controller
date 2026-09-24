# Migrates Stream Deck buttons from the upstream Multi OBS Controller plugin
# (dev.theca11.multiobs) to this fork (uk.1a3.multiobs), keeping all settings.
# Backs up the profile folders before changing anything.

$old = 'dev.theca11.multiobs'
$new = 'uk.1a3.multiobs'

$sdRoot = Join-Path $env:APPDATA 'Elgato\StreamDeck'
$profileDirs = 'ProfilesV2', 'ProfilesV3' |
	ForEach-Object { Join-Path $sdRoot $_ } |
	Where-Object { Test-Path $_ }

if (-not $profileDirs) {
	Write-Host 'No Stream Deck profile folders found.'
	exit 1
}

# Stream Deck must be closed or it will overwrite the changes on exit
$sd = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($sd) {
	Write-Host 'Closing Stream Deck...'
	$sd | Stop-Process
	$sd | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
}
$exe = 'C:\Program Files\Elgato\StreamDeck\StreamDeck.exe'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$changed = 0
foreach ($dir in $profileDirs) {
	$backup = "$dir.backup-$stamp"
	Copy-Item $dir $backup -Recurse
	Write-Host "Backup: $backup"

	Get-ChildItem $dir -Recurse -Filter '*.json' -File | ForEach-Object {
		$text = [IO.File]::ReadAllText($_.FullName)
		if ($text.Contains($old)) {
			[IO.File]::WriteAllText($_.FullName, $text.Replace($old, $new), (New-Object Text.UTF8Encoding $false))
			$changed++
		}
	}
}

Write-Host "Updated $changed profile file(s)."
if ($sd -and (Test-Path $exe)) {
	Write-Host 'Restarting Stream Deck...'
	Start-Process $exe
}
Write-Host 'Done. You can uninstall the original Multi OBS Controller plugin now.'
