$ErrorActionPreference = 'Stop'
# Use the native OS architecture even under an emulated PowerShell process.
$oriArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($oriArch) {
    'AMD64' { $oriTarget = 'windows-amd64' }
    'ARM64' { $oriTarget = 'windows-arm64' }
    default { throw "Ori: unsupported Windows architecture: $oriArch" }
}
$oriBinary = Join-Path (Split-Path $PSScriptRoot -Parent) "bin/$oriTarget/ori.exe"
if (-not (Test-Path -LiteralPath $oriBinary -PathType Leaf)) {
    if ($env:ORI_NO_BUILD -eq '1') { exit 0 }
    throw "Ori: bundled binary missing: $oriBinary. Reinstall the plugin."
}
& $oriBinary @args
exit $LASTEXITCODE
