# Installs a CODA SDK from the GitHub Release of ubeffiong/coda-sdks, verified against SHA256SUMS.
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.ps1))) dotnet
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.ps1))) python 0.1.0
#
# Languages: typescript, python, dotnet, java, go, rust. Run it inside your project folder.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('typescript', 'javascript', 'python', 'dotnet', 'csharp', 'java', 'go', 'rust')]
    [string] $Language,
    [Parameter(Position = 1)]
    [string] $Version
)
$ErrorActionPreference = 'Stop'
$repo = if ($env:CODA_SDK_REPO) { $env:CODA_SDK_REPO } else { 'ubeffiong/coda-sdks' }
$Language = @{ javascript = 'typescript'; csharp = 'dotnet' }[$Language] ?? $Language

function Need([string] $tool) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "coda-sdk: $tool is required for the $Language SDK" }
}

if (-not $Version) {
    $Version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
$Version = $Version.TrimStart('v')
$base = "https://github.com/$repo/releases/download/v$Version"
Write-Host "coda-sdk: installing the $Language SDK $Version from $repo"

$work = Join-Path ([IO.Path]::GetTempPath()) ("coda-sdk-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null

function Fetch([string] $file) {
    $target = Join-Path $work $file
    Invoke-WebRequest "$base/$file" -OutFile $target -UseBasicParsing
    $sums = (Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing).Content -split "`n"
    $line = $sums | Where-Object { $_ -match " $([regex]::Escape($file))\s*$" } | Select-Object -First 1
    if (-not $line) { throw "coda-sdk: $file is not listed in SHA256SUMS" }
    $expected = ($line -split ' ')[0]
    $actual = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "coda-sdk: checksum mismatch for $file" }
    Write-Host "coda-sdk: verified $file"
    return $target
}

try {
    switch ($Language) {
        'typescript' {
            Need npm
            $pkg = Fetch "coda-terminology-client-$Version.tgz"
            New-Item -ItemType Directory -Force -Path .coda-sdk | Out-Null
            Copy-Item $pkg .coda-sdk/
            npm install "./.coda-sdk/coda-terminology-client-$Version.tgz"
        }
        'python' {
            $py = (Get-Command python -ErrorAction SilentlyContinue) ?? (Get-Command py -ErrorAction SilentlyContinue)
            if (-not $py) { throw 'coda-sdk: python is required' }
            $whl = Fetch "coda_client-$Version-py3-none-any.whl"
            & $py.Source -m pip install $whl
        }
        'dotnet' {
            Need dotnet
            $pkg = Fetch "Coda.Client.$Version.nupkg"
            New-Item -ItemType Directory -Force -Path .coda-sdk | Out-Null
            Copy-Item $pkg .coda-sdk/
            dotnet add package Coda.Client --version $Version --source (Resolve-Path .coda-sdk).Path
        }
        'java' {
            Need mvn
            $jar = Fetch "coda-client-$Version.jar"
            mvn -q install:install-file "-Dfile=$jar" -DgroupId=io.github.ubeffiong -DartifactId=coda-client "-Dversion=$Version" -Dpackaging=jar
            Write-Host "`nAdd to your pom.xml:`n  <dependency><groupId>io.github.ubeffiong</groupId><artifactId>coda-client</artifactId><version>$Version</version></dependency>"
        }
        'go' { Need go; go get "github.com/$repo/go@v$Version" }
        'rust' { Need cargo; cargo add coda-client --git "https://github.com/$repo" --tag "v$Version" }
    }
    Write-Host "coda-sdk: done. Docs: https://github.com/$repo/tree/main/$Language"
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
