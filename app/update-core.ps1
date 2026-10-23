# Pure update validation/transaction functions. Importing this file changes no state.
$ErrorActionPreference = 'Stop'
function Get-CmcpVersion([string]$Value) {
    if ($Value -notmatch '^v?(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$') { throw 'Invalid stable version' }
    return [version]($Value.TrimStart('v'))
}
function Select-CmcpRelease($Release,[string]$Current) {
    if ($Release.draft -ne $false -or $Release.prerelease -ne $false) { throw 'Not a stable release' }
    $version = Get-CmcpVersion ([string]$Release.tag_name)
    if ($version -le (Get-CmcpVersion $Current)) { return $null }
    $name = 'CMCP-' + $version.ToString(3) + '-windows-x64.zip'
    $zip = @($Release.assets | Where-Object { $_.name -ceq $name })
    $sum = @($Release.assets | Where-Object { $_.name -ceq ($name + '.sha256') })
    if ($zip.Count -ne 1 -or $sum.Count -ne 1 -or $zip[0].size -lt 1 -or $zip[0].size -gt 268435456 -or $sum[0].size -gt 1024) { throw 'Missing Windows x64 release assets' }
    foreach ($asset in @($zip[0],$sum[0])) {
        $expected = 'https://github.com/isAlexYoung/cmcp/releases/download/' + $Release.tag_name + '/' + $asset.name
        if ($asset.browser_download_url -cne $expected) { throw 'Unexpected release asset URL' }
    }
    return [pscustomobject]@{version=$version.ToString(3);name=$name;zip=$zip[0];checksum=$sum[0]}
}
function Receive-CmcpFile([string]$Url,[string]$Destination,[long]$Limit) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $uri = [uri]$Url
    for ($redirect=0; $redirect -le 5; $redirect++) {
        if ($uri.Scheme -cne 'https' -or !$uri.IsDefaultPort -or $uri.UserInfo -or $uri.Host -notin @('api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')) { throw 'Untrusted download host' }
        $request = [Net.HttpWebRequest]::Create($uri); $request.AllowAutoRedirect=$false; $request.UserAgent='CMCP-updater/4.1';$request.Timeout=45000;$request.ReadWriteTimeout=45000
        # Same network policy as the existing connector: explicit proxy, then Windows proxy.
        $proxyValue = $env:HTTPS_PROXY; if (!$proxyValue) { $proxyValue=$env:ALL_PROXY }
        if ($proxyValue) { $proxyUri=[uri]$proxyValue; if ($proxyUri.Scheme -notin @('http','https')) { throw 'Unsupported proxy scheme' };$request.Proxy=New-Object Net.WebProxy($proxyUri) }
        $response=$request.GetResponse()
        try {
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) { $uri=New-Object uri($uri,$response.Headers['Location']); continue }
            if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt $Limit) { throw 'Download response rejected' }
            $sourceStream=$response.GetResponseStream();$output=New-Object IO.FileStream($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {$buffer=New-Object byte[] 65536;$total=0L;$deadline=[DateTime]::UtcNow.AddMinutes(8);while(($length=$sourceStream.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$length;if($total -gt $Limit -or [DateTime]::UtcNow -gt $deadline){throw 'Download limit exceeded'};$output.Write($buffer,0,$length)};if($response.ContentLength -ge 0 -and $total -ne $response.ContentLength){throw 'Incomplete download'}} finally {$output.Dispose();$sourceStream.Dispose()}
            return
        } finally {$response.Dispose()}
    }
    throw 'Too many download redirects'
}
function Test-CmcpChecksum([string]$Zip,[string]$Text,[string]$Name,[string]$Digest) {
    if ($Text.Trim() -cnotmatch ('^([a-fA-F0-9]{64})  '+[regex]::Escape($Name)+'$')) { throw 'Invalid checksum file' }
    $expected=$Matches[1].ToLowerInvariant();$actual=(Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected -or ($Digest -and $Digest -cne ('sha256:'+$actual))) { throw 'Release checksum mismatch' }
    return $actual
}
function Test-CmcpRelative([string]$Path) {
    if (!$Path -or $Path.Length -gt 240 -or $Path.Contains('\') -or $Path.StartsWith('/') -or $Path.Contains(':')) { throw 'Invalid package path' }
    foreach ($part in $Path.Split('/')) {
        if (!$part -or $part -in @('.','..') -or $part -match '[\x00-\x1f<>"|?*]' -or $part.EndsWith(' ') -or $part.EndsWith('.') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') { throw 'Unsafe package path' }
    }
    return $true
}
function Get-CmcpFiles([string]$Root) {
    if ((Get-Item -LiteralPath $Root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse installation root' }
    $stack=New-Object 'Collections.Generic.Stack[string]';$stack.Push($Root)
    while ($stack.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in installation' }
            if ($item.PSIsContainer) { if($item.Name -eq '.git'){throw 'Source checkout is protected'};$stack.Push($item.FullName) } else {$item}
        }
    }
}
function Test-CmcpTree([string]$Root,[string]$Version='') {
    $full=[IO.Path]::GetFullPath($Root).TrimEnd('\');$file=Join-Path $full 'app\distribution-manifest.json'
    if (!(Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -gt 8388608) { throw 'Installation manifest required' }
    $data=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($data.schema -ne 1 -or $data.platform -cne 'windows-x64' -or ($Version -and $data.version -cne $Version)) { throw 'Wrong distribution manifest' }
    $null=Get-CmcpVersion $data.version
    $inventory=@{};foreach($entry in $data.files){$null=Test-CmcpRelative $entry.path;if($entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $inventory.ContainsKey($entry.path)){throw 'Invalid manifest entry'};$inventory[$entry.path]=$entry.sha256}
    foreach($required in @('Claude-MCP.exe','app/package.json','app/runtime/node.exe','app/update.ps1','app/update-core.ps1','app/update-apply.ps1','app/manager-restart.ps1')){if(!$inventory.ContainsKey($required)){throw 'Incomplete package'}}
    $seen=@{};foreach($item in Get-CmcpFiles $full){$relative=$item.FullName.Substring($full.Length+1).Replace('\','/');if($relative -ceq 'app/distribution-manifest.json'){continue};if(!$inventory.ContainsKey($relative) -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inventory[$relative]){throw 'Installation contains unknown or modified files; download manually'};$seen[$relative]=$true}
    if($seen.Count -ne $inventory.Count){throw 'Installation file missing'}
    if((Get-Content -LiteralPath (Join-Path $Root 'app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version -cne $data.version){throw 'Package version mismatch'}
    return $data
}
function Expand-CmcpPackage([string]$Zip,[string]$Destination,[string]$Version) {
    if(Test-Path -LiteralPath $Destination){throw 'Staging path already exists'}
    Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
    $archive=[IO.Compression.ZipFile]::OpenRead($Zip)
    try{
        if($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 25000){throw 'Package entry limit'}
        $prefix='CMCP-'+$Version+'-windows-x64/';$seen=@{};$size=0L
        # Validate every entry before writing any bytes.
        foreach($entry in $archive.Entries){$path=$entry.FullName;if(!$path.StartsWith($prefix,[StringComparison]::Ordinal)){throw 'Wrong ZIP root'};$relative=$path.Substring($prefix.Length).TrimEnd('/');if(!$relative){continue};$null=Test-CmcpRelative $relative;if($seen.ContainsKey($relative)){throw 'Duplicate ZIP path'};$seen[$relative]=$true;$type=($entry.ExternalAttributes -shr 16) -band 0xF000;if($type -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400)){throw 'ZIP links are forbidden'};$size+=$entry.Length;if($entry.Length -gt 268435456 -or $size -gt 1073741824){throw 'Uncompressed package limit'}}
        $null=New-Item -ItemType Directory -Path $Destination
        foreach($entry in $archive.Entries){$relative=$entry.FullName.Substring($prefix.Length);if(!$relative){continue};$target=Join-Path $Destination $relative.Replace('/','\');if($relative.EndsWith('/')){$null=New-Item -ItemType Directory -Path $target -Force;continue};$null=New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force;$sourceStream=$entry.Open();$output=New-Object IO.FileStream($target,[IO.FileMode]::CreateNew);try{$sourceStream.CopyTo($output)}finally{$output.Dispose();$sourceStream.Dispose()}}
    }finally{$archive.Dispose()}
    return Test-CmcpTree $Destination $Version
}
function Assert-CmcpInstallRoot([string]$Root) {
    $full=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    foreach($forbidden in @([IO.Path]::GetPathRoot($full).TrimEnd('\'),$env:USERPROFILE,$env:WINDIR,[Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('LocalApplicationData'))){if($forbidden -and $full -ieq $forbidden.TrimEnd('\')){throw 'Unsafe installation location'}}
    if(Test-Path -LiteralPath (Join-Path $full '.git')){throw 'Source checkout is protected'}
    $null=Test-CmcpTree $full
    return $full
}
function Invoke-CmcpSwap([string]$Install,[string]$Staged,[string]$Backup,[scriptblock]$Start,[scriptblock]$Healthy,[scriptblock]$StopFailed) {
    # Paths are validated by caller; the backup never overwrites an existing folder.
    if(Test-Path -LiteralPath $Backup){throw 'Backup path already exists'}
    [IO.Directory]::Move($Install,$Backup)
    $placed=$false;$process=$null
    try{[IO.Directory]::Move($Staged,$Install);$placed=$true;$process=& $Start $Install;if(!(& $Healthy $process)){throw 'New application did not become healthy'};return $true}
    catch{if($process){try{& $StopFailed $process}catch{}};if($placed){[IO.Directory]::Move($Install,$Staged)};[IO.Directory]::Move($Backup,$Install);$null=& $Start $Install;throw}
}
