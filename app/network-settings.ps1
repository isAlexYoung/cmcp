# Shared proxy policy for the connector, legacy cloud requests and updater.
$script:CmcpNetworkDefaultState = Join-Path (Split-Path $PSScriptRoot -Parent) 'user'
function Get-CmcpProxyUrl([string]$Url) {
    $directory=$script:CmcpNetworkDefaultState
    if($script:CmcpNetworkStateDirectory){$directory=$script:CmcpNetworkStateDirectory}
    elseif($env:CMCP_STATE_DIR){$directory=$env:CMCP_STATE_DIR}
    elseif(Get-Variable StateDir -Scope Script -ErrorAction SilentlyContinue){$directory=$script:StateDir}
    $file=Join-Path $directory 'application-preferences.json'
    $mode='auto';$settings=$null
    if(Test-Path -LiteralPath $file){
        if((Get-Item -LiteralPath $file).Length -gt 32768){throw 'Invalid network preferences'}
        $settings=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
        if($settings.schema -ne 1){throw 'Invalid network preferences'}
        if($null -ne $settings.proxyMode){$mode=$settings.proxyMode}
    }
    if($mode -notin @('auto','manual','direct')){throw 'Invalid proxy mode'}
    if($mode -eq 'direct'){return ''}
    if($mode -eq 'manual'){
        if($settings.proxyHost -isnot [string] -or $settings.proxyPort -isnot [int] -or $settings.proxyPort -lt 1 -or $settings.proxyPort -gt 65535){throw 'Invalid manual proxy address or port'}
        $hostName=$settings.proxyHost.Trim().Trim('[',']')
        if(!$hostName -or $hostName -match '[\s/@?#\\]' -or [Uri]::CheckHostName($hostName) -eq [UriHostNameType]::Unknown){throw 'Invalid manual proxy host'}
        return ([UriBuilder]::new('http',$hostName,$settings.proxyPort)).Uri.GetLeftPart([UriPartial]::Authority)
    }
    foreach($name in @('HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy')){
        $value=[Environment]::GetEnvironmentVariable($name)
        if(!$value){continue}
        $candidate=$null
        if(![Uri]::TryCreate($value.Trim(),[UriKind]::Absolute,[ref]$candidate) -or $candidate.Scheme -notin @('http','https') -or !$candidate.Host -or $candidate.AbsolutePath -ne '/' -or $candidate.Query -or $candidate.Fragment){throw 'Unsupported proxy environment setting; choose a manual HTTP proxy in Settings'}
        return $candidate.AbsoluteUri.TrimEnd('/')
    }
    $uri=[Uri]$Url
    $system=[Net.WebRequest]::GetSystemWebProxy()
    if($system.IsBypassed($uri)){return ''}
    $proxy=$system.GetProxy($uri)
    if($proxy -and $proxy -ne $uri){
        if($proxy.Scheme -notin @('http','https')){throw 'Unsupported system proxy'}
        return $proxy.GetLeftPart([UriPartial]::Authority)
    }
    return ''
}
function Get-CmcpWebProxy([string]$Url){
    $address=Get-CmcpProxyUrl $Url
    if($address){return [Net.WebProxy]::new([Uri]$address,$false)}
    return [Net.WebProxy]::new()
}
function New-CmcpWebSession([string]$Url){
    $null=Get-Command Invoke-WebRequest
    $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $session.Proxy=Get-CmcpWebProxy $Url
    return $session
}
