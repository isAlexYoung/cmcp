param([string]$NodeExe)
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
if (!$NodeExe) { $NodeExe = Join-Path $source 'runtime\node.exe' }
$build = [IO.Path]::GetFullPath((Join-Path (Split-Path $source -Parent) 'build-results'))
$scratch = Join-Path $build ('cmcp-path-' + [guid]::NewGuid().ToString('N'))
$KitDir = Join-Path $scratch ('AI ProgramFiles ' + [char]0x4e2d + '\CMCP\app')
$previousState = $env:CMCP_STATE_DIR

try {
    $null = New-Item -ItemType Directory -Path (Join-Path $KitDir 'runtime') -Force
    Get-ChildItem -LiteralPath $source -File | Copy-Item -Destination $KitDir
    foreach ($folder in @('node_modules', 'mcp-presets', 'mcp-tools-template')) {
        Copy-Item -LiteralPath (Join-Path $source $folder) -Destination $KitDir -Recurse
    }
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $KitDir 'runtime\node.exe')

    $env:CMCP_STATE_DIR = Join-Path $scratch 'User Data'
    $null = New-Item -ItemType Directory -Path $env:CMCP_STATE_DIR
    $config = @{token = ('a' * 64); roots = @($env:CMCP_STATE_DIR)} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $env:CMCP_STATE_DIR 'config.json'), $config)
    . (Join-Path $KitDir 'common.ps1')
    function Write-Step($Message) {}
    function Write-Ok($Message) {}

    # Run the real startup check without registering autostart or contacting a VPS.
    $tokens = $null
    $errors = $null
    $start = [Management.Automation.Language.Parser]::ParseFile((Join-Path $KitDir 'start.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors) { throw ($errors -join ', ') }
    $check = $start.Find({
        param($ast)
        $ast -is [Management.Automation.Language.FunctionDefinitionAst] -and $ast.Name -eq 'Test-Environment'
    }, $false)
    & $check.Body.GetScriptBlock()
    if (!(Select-String -LiteralPath (Join-Path $env:CMCP_STATE_DIR 'service.log') -Pattern 'starting.*node v')) {
        throw 'The actual backend did not run from the fixture'
    }
    [IO.File]::WriteAllText($NodeArgsFile, '')
    & $check.Body.GetScriptBlock()

    # Exercise the Windows argument boundary, including empty and quoted values.
    $expected = @('', ('quoted "value"'), ($env:CMCP_STATE_DIR + '\'), 'no-space')
    $entry = Join-Path $KitDir 'echo arguments.mjs'
    [IO.File]::WriteAllText($entry, 'console.log(JSON.stringify({args: process.argv.slice(2)}))')
    $result = Invoke-Capture (Get-NodeExe) (@($entry) + $expected) 10 $KitDir
    if ($result.Code -ne 0) { throw "Native argument round trip failed: $($result.Err)" }
    $actual = (ConvertFrom-Json -InputObject $result.Out).args
    if ((ConvertTo-Json -InputObject $actual -Compress) -cne (ConvertTo-Json -InputObject $expected -Compress)) { throw 'Native arguments changed' }
    Write-Output 'PASS: startup self-test and native arguments from an installation path with spaces'
} finally {
    $env:CMCP_STATE_DIR = $previousState
    if ([IO.Path]::GetDirectoryName($scratch) -eq $build -and [IO.Path]::GetFileName($scratch) -match '^cmcp-path-[a-f0-9]{32}$' -and [IO.Directory]::Exists($scratch)) {
        Remove-Item -LiteralPath $scratch -Recurse -Force
    }
}
