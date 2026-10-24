param([Parameter(Mandatory=$true)][string]$OutputFile,[Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-launcher-'+[guid]::NewGuid().ToString('N')+'.cs')
try{
    [IO.File]::WriteAllText($temporary,('[assembly: System.Reflection.AssemblyTitle("CMCP")][assembly: System.Reflection.AssemblyProduct("CMCP")][assembly: System.Reflection.AssemblyVersion("'+$Version+'.0")][assembly: System.Reflection.AssemblyFileVersion("'+$Version+'.0")]'))
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output /codepage:65001 /reference:System.Windows.Forms.dll ("/win32manifest:"+(Join-Path $PSScriptRoot 'desktop-ui/app.manifest')) ("/win32icon:"+(Join-Path $root 'app/assets/claude-desktop.ico')) ("/out:"+[IO.Path]::GetFullPath($OutputFile)) (Join-Path $PSScriptRoot 'desktop-ui/LegacyLauncher.cs') $temporary
    if($LASTEXITCODE -ne 0){throw 'Compatibility launcher build failed'}
}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}}
