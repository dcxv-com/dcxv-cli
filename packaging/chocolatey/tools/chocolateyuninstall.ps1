$ErrorActionPreference = 'Stop'

Uninstall-BinFile -Name 'dcxv'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Remove-Item (Join-Path $toolsDir 'dcxv.exe') -ErrorAction SilentlyContinue
