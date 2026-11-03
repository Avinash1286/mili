$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$toolRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.tokai\tools'))
if (-not $toolRoot.StartsWith($workspaceRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid local tools directory.' }
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
$archive = Join-Path $toolRoot 'keycloak-26.8.1.zip'
if (-not (Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest -Uri 'https://github.com/keycloak/keycloak/releases/download/26.8.1/keycloak-26.8.1.zip' -OutFile $archive
}
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne '4cd312c889af358a819a74a6c6f068f9ea159a6959e49924607cec95cfd4c1a4') { throw 'Keycloak archive checksum mismatch. No files extracted.' }
if (-not (Test-Path -LiteralPath (Join-Path $toolRoot 'keycloak-26.8.1\bin\kc.bat'))) { Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot }
Write-Output 'Official Keycloak26.8.1 verified and installed inside the ignored workspace tools directory.'
