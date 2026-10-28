[CmdletBinding()]
param(
    [int[]] $Pools = @(2, 10),
    [int[]] $Vus = @(1, 10, 50),
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $Duration = '30s',
    [ValidateRange(0, 1000)] [int] $Warmup = 20,
    [ValidateRange(1, 5)] [int] $Repeats = 1,
    [ValidateRange(1000, 30000)] [int] $ConnectionTimeoutMs = 1000,
    [string] $Ids = '1,2,3,4,5,6,7,8,9,10',
    [string] $BaseUrl = 'http://127.0.0.1:8080',
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ($Pools.Count -eq 0 -or @($Pools | Where-Object { $_ -lt 1 -or $_ -gt 32 }).Count -gt 0) {
    throw 'Pools must contain values from 1 through 32 (PostgreSQL max_connections is 50).'
}
if ($Vus.Count -eq 0 -or @($Vus | Where-Object { $_ -lt 1 -or $_ -gt 200 }).Count -gt 0) {
    throw 'Vus must contain values from 1 through 200.'
}
if (-not $OutputDirectory) {
    $runId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputDirectory = Join-Path $PSScriptRoot "results/pool-matrix-$runId"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$variableNames = @('DB_POOL_SIZE', 'DB_POOL_MIN_IDLE', 'DB_CONNECTION_TIMEOUT_MS', 'DB_VALIDATION_TIMEOUT_MS')
$originalValues = @{}
$originalRunningValues = @{}
foreach ($name in $variableNames) {
    $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$points = [System.Collections.Generic.List[object]]::new()
$sequence = 0
$anyFailure = $false
$restoreFailed = $false
$baselineDataset = $null
$baselineJson = $null

function Start-ConfiguredServer {
    & docker compose up -d --no-deps --wait --wait-timeout 120 server
    if ($LASTEXITCODE -ne 0) {
        throw 'Server failed to become healthy with the selected pool settings.'
    }
}

Push-Location $repositoryRoot
try {
    $baselineDataset = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 10
    $baselineJson = $baselineDataset | ConvertTo-Json -Depth 10 -Compress
    foreach ($name in $variableNames) {
        $runningValue = & docker compose exec -T server printenv $name
        if ($LASTEXITCODE -eq 0 -and ([string] $runningValue).Trim() -match '^\d+$') {
            $originalRunningValues[$name] = ([string] $runningValue).Trim()
        }
    }
    foreach ($poolSize in $Pools) {
        $env:DB_POOL_SIZE = [string] $poolSize
        $env:DB_POOL_MIN_IDLE = [string] $poolSize
        $env:DB_CONNECTION_TIMEOUT_MS = [string] $ConnectionTimeoutMs
        $env:DB_VALIDATION_TIMEOUT_MS = '500'
        Start-ConfiguredServer

        foreach ($concurrency in $Vus) {
            for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
                $order = if ($sequence % 2 -eq 0) { @('v1', 'v2') } else { @('v2', 'v1') }
                foreach ($strategy in $order) {
                    $filename = "pool-$poolSize-vus-$concurrency-repeat-$repeat-$strategy.json"
                    $reportPath = Join-Path $outputPath $filename
                    Write-Host "Pool=$poolSize VUs=$concurrency repeat=$repeat strategy=$strategy"
                    & node benchmarks/pool-run.mjs --base-url $BaseUrl --strategy $strategy --model closed `
                        --vus $concurrency --duration $Duration --warmup $Warmup --ids $Ids --output $reportPath
                    $runExitCode = $LASTEXITCODE
                    $datasetMatchesBaseline = $false
                    $poolMatchesExpected = $false
                    $cleanupConfirmed = $false
                    if (Test-Path -LiteralPath $reportPath) {
                        $pointReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
                        $pointBefore = $pointReport.datasetBefore | ConvertTo-Json -Depth 10 -Compress
                        $pointAfter = $pointReport.datasetAfter | ConvertTo-Json -Depth 10 -Compress
                        $datasetMatchesBaseline = ($pointBefore -eq $baselineJson -and $pointAfter -eq $baselineJson)
                        $actualPools = @($pointReport.pools)
                        $poolMatchesExpected = ($actualPools.Count -eq 1 -and $actualPools[0].configuredMaximum -eq $poolSize)
                        $cleanupConfirmed = ($pointReport.runner.cliTerminated -eq $true -and
                            @('removed', 'already_absent') -contains $pointReport.runner.cleanup.after.status)
                    }
                    $points.Add([pscustomobject]@{
                        poolSize = $poolSize
                        minimumIdle = $poolSize
                        connectionTimeoutMs = $ConnectionTimeoutMs
                        vus = $concurrency
                        repeat = $repeat
                        strategy = $strategy
                        exitCode = $runExitCode
                        datasetMatchesBaseline = $datasetMatchesBaseline
                        poolMatchesExpected = $poolMatchesExpected
                        cleanupConfirmed = $cleanupConfirmed
                        report = $reportPath
                    })
                    if ($runExitCode -ne 0) {
                        $anyFailure = $true
                    }
                    if (-not $datasetMatchesBaseline) {
                        throw 'Dataset metadata differs from the matrix baseline or the result report is missing; stopping incomparable points.'
                    }
                    if (-not $poolMatchesExpected) {
                        throw 'The actual measured pool maximum differs from the requested setting; check the target URLs and Compose configuration.'
                    }
                    if (-not $cleanupConfirmed) {
                        throw 'Workload cleanup was not confirmed; stopping before another load can overlap.'
                    }
                    if ($pointReport.runner.stopReason -in @('SIGINT', 'SIGTERM')) {
                        throw 'Workload interrupted; stopping the matrix.'
                    }
                }
                $sequence++
            }
        }
    }
} finally {
    foreach ($name in $variableNames) {
        [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process')
    }
    try {
        # Restore actual running pool overrides even when they differed from .env.
        foreach ($name in $originalRunningValues.Keys) {
            [Environment]::SetEnvironmentVariable($name, $originalRunningValues[$name], 'Process')
        }
        Start-ConfiguredServer
        # nginx resolves the server's Docker address when loading its config.
        $clientId = & docker compose ps --status running -q client
        if ($clientId) {
            & docker compose exec -T client nginx -s reload
        }
    } catch {
        $restoreFailed = $true
        Write-Warning "Could not restore the configured server: $($_.Exception.Message)"
    } finally {
        foreach ($name in $variableNames) {
            [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process')
        }
    }

    $manifest = [pscustomobject]@{
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        note = 'Closed-loop points run sequentially; strategy order alternates. Dataset is not replaced. Recorded running pool settings and the original process environment are restored on completion.'
        restoreFailed = $restoreFailed
        originalRunningPoolSettings = $originalRunningValues
        datasetBaseline = $baselineDataset
        points = @($points.ToArray())
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputPath 'manifest.json') -Encoding utf8
    Pop-Location
}

Write-Host "Reports: $outputPath"
if ($anyFailure -or $restoreFailed) {
    exit 1
}
