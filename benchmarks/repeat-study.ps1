[CmdletBinding()]
param(
    [int[]] $Pools = @(2, 10),
    [ValidateRange(1, 10)] [int] $Repeats = 5,
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $Duration = '30s',
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $WarmupDuration = '20s',
    [ValidateRange(0, 1000)] [int] $WarmupRequests = 20,
    [ValidateRange(1, 5000)] [int] $ArrivalRate = 600,
    [ValidateRange(1, 500)] [int] $PreallocatedVus = 100,
    [ValidateRange(1, 500)] [int] $MaxVus = 200,
    [ValidateRange(1000, 30000)] [int] $ConnectionTimeoutMs = 1000,
    [string] $Ids = '1,2,3,4,5,6,7,8,9,10',
    [string] $BaseUrl = 'http://127.0.0.1:8080',
    [string] $DockerBaseUrl = 'http://server:8080',
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ($Pools.Count -eq 0 -or @($Pools | Where-Object { $_ -lt 1 -or $_ -gt 32 }).Count -gt 0) {
    throw 'Pools must contain values from 1 through 32.'
}
if (@($Pools | Select-Object -Unique).Count -ne $Pools.Count) {
    throw 'Pools must not contain duplicate settings.'
}
if ($PreallocatedVus -gt $MaxVus) {
    throw 'PreallocatedVus must not exceed MaxVus.'
}
foreach ($durationText in @($Duration, $WarmupDuration)) {
    $durationMatch = [regex]::Match($durationText, '^(\d+)(ms|s|m)$')
    $durationMultiplier = @{ ms = 1; s = 1000; m = 60000 }[$durationMatch.Groups[2].Value]
    $durationMilliseconds = [double] $durationMatch.Groups[1].Value * $durationMultiplier
    if ($durationMilliseconds -lt 1000 -or $durationMilliseconds -gt 600000) {
        throw 'Duration and WarmupDuration must be between 1s and 10m.'
    }
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot ('results/repeated-study-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $outputPath 'campaign.json')) {
    throw 'OutputDirectory already contains a campaign. Choose a new directory to preserve existing results.'
}

$variableNames = @('DB_POOL_SIZE', 'DB_POOL_MIN_IDLE', 'DB_CONNECTION_TIMEOUT_MS', 'DB_VALIDATION_TIMEOUT_MS')
$originalValues = @{}
$originalRunningValues = @{}
foreach ($name in $variableNames) {
    $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$points = [System.Collections.Generic.List[object]]::new()
$conditions = @(
    [pscustomobject]@{ id = 'closed-vus-1'; model = 'closed'; vus = 1; rate = $null },
    [pscustomobject]@{ id = 'closed-vus-20'; model = 'closed'; vus = 20; rate = $null },
    [pscustomobject]@{ id = "arrival-rate-$ArrivalRate"; model = 'arrival'; vus = $null; rate = $ArrivalRate }
)
$totalMeasuredRuns = $Pools.Count * $Repeats * $conditions.Count * 2
$restoreNeeded = $false
$anyLoadFailure = $false
$campaign = [ordered]@{
    schemaVersion = 1
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    completedAt = $null
    status = 'running'
    error = $null
    restoreFailed = $false
    restoreError = $null
    parameters = [ordered]@{
        pools = $Pools; repeats = $Repeats; duration = $Duration; warmupDuration = $WarmupDuration
        warmupRequests = $WarmupRequests; arrivalRate = $ArrivalRate
        preallocatedVus = $PreallocatedVus; maxVus = $MaxVus
        connectionTimeoutMs = $ConnectionTimeoutMs; validationTimeoutMs = 500
        requestTimeout = '10s'; ids = $Ids; baseUrl = $BaseUrl; dockerBaseUrl = $DockerBaseUrl
        totalMeasuredRuns = $totalMeasuredRuns
    }
    design = 'Sequential isolated runs. Each pool has discarded timed warmups for both strategies. Each repetition rotates the three conditions; AB/BA order alternates. Analyze run pairs, not individual requests as independent repetitions.'
    source = $null
    originalRunningPoolSettings = $originalRunningValues
    datasetBaseline = $null
    datasetAfter = $null
    datasetUnchanged = $null
    points = @()
}

function Write-JsonFile {
    param([string] $Path, [object] $Value)
    $temporaryPath = $Path + '.tmp'
    $json = $Value | ConvertTo-Json -Depth 14
    [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Save-Campaign {
    param([object] $LastPoint = $null)
    $campaign.points = @($points.ToArray())
    Write-JsonFile -Path (Join-Path $outputPath 'campaign.json') -Value $campaign
    $measured = @($campaign.points | Where-Object { $_.phase -eq 'measure' })
    Write-JsonFile -Path (Join-Path $outputPath 'progress.json') -Value ([ordered]@{
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        status = $campaign.status
        measuredCompleted = $measured.Count
        measuredTotal = $totalMeasuredRuns
        allPointsCompleted = $points.Count
        lastPoint = $LastPoint
        error = $campaign.error
        restoreFailed = $campaign.restoreFailed
    })
}

function Start-ConfiguredServer {
    & docker compose up -d --no-deps --wait --wait-timeout 120 server
    if ($LASTEXITCODE -ne 0) {
        throw 'Server failed to become healthy with the selected pool settings.'
    }
}

function Invoke-StudyPoint {
    param(
        [string] $Phase, [int] $PoolSize, [int] $PoolIndex, [object] $Condition,
        [int] $Repeat, [string] $Strategy, [int] $Order, [int] $ConditionOrder,
        [string] $RunDuration
    )
    $filename = "$Phase-pool-$PoolSize-$($Condition.id)-repeat-$Repeat-$Strategy.json"
    $reportPath = Join-Path $outputPath $filename
    $arguments = @('benchmarks/pool-run.mjs', '--base-url', $BaseUrl, '--docker-base-url', $DockerBaseUrl,
        '--strategy', $Strategy, '--model', $Condition.model, '--duration', $RunDuration,
        '--warmup', [string] $WarmupRequests, '--ids', $Ids, '--request-timeout', '10s', '--output', $reportPath)
    if ($Condition.model -eq 'arrival') {
        $arguments += @('--rate', [string] $Condition.rate, '--preallocated-vus', [string] $PreallocatedVus, '--max-vus', [string] $MaxVus)
    } else {
        $arguments += @('--vus', [string] $Condition.vus)
    }
    Write-Host "$Phase pool=$PoolSize condition=$($Condition.id) repeat=$Repeat strategy=$Strategy order=$Order"
    & node @arguments
    $runExitCode = $LASTEXITCODE
    $report = if (Test-Path -LiteralPath $reportPath) { Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json } else { $null }
    $beforeJson = $report.datasetBefore | ConvertTo-Json -Depth 10 -Compress
    $afterJson = $report.datasetAfter | ConvertTo-Json -Depth 10 -Compress
    $datasetMatches = ($null -ne $report -and $beforeJson -eq $script:baselineJson -and $afterJson -eq $script:baselineJson)
    $actualPools = @($report.pools)
    $poolMatches = ($actualPools.Count -eq 1 -and $actualPools[0].configuredMaximum -eq $PoolSize)
    $cleanupConfirmed = ($report.runner.cliTerminated -eq $true -and @('removed', 'already_absent') -contains $report.runner.cleanup.after.status)
    $poolMetricsValid = ($actualPools.Count -eq 1 -and -not $actualPools[0].counterReset -and
        @($actualPools[0].missingMetrics).Count -eq 0 -and -not $actualPools[0].sampledMaximumChanged -and
        $actualPools[0].acquire.histogramAvailable -eq $true -and $actualPools[0].usage.histogramAvailable -eq $true)
    $measurementValid = ($null -ne $report.k6 -and $report.pollErrorCount -eq 0 -and
        $poolMetricsValid -and $report.status -notin @('error', 'measurement_invalid'))
    $point = [pscustomobject]@{
        phase = $Phase; sequence = $points.Count + 1; poolSize = $PoolSize; poolIndex = $PoolIndex
        condition = $Condition.id; model = $Condition.model; vus = $Condition.vus; rate = $Condition.rate
        repeat = $Repeat; strategy = $Strategy; order = $Order; conditionOrder = $ConditionOrder
        duration = $RunDuration; status = $report.status; exitCode = $runExitCode; report = $reportPath
        validation = [ordered]@{ datasetMatchesBaseline = $datasetMatches; poolMatchesExpected = $poolMatches
            cleanupConfirmed = $cleanupConfirmed; measurementValid = $measurementValid }
    }
    $points.Add($point)
    $pool = if ($actualPools.Count -eq 1) { $actualPools[0] } else { $null }
    $compact = [ordered]@{
        phase = $Phase; poolSize = $PoolSize; condition = $Condition.id; repeat = $Repeat
        strategy = $Strategy; order = $Order; status = $report.status; report = $reportPath
        httpP95Ms = $report.k6.results.metrics.measured_http_ms.values.'p(95)'
        completedRps = $report.k6.measurements.completedRequestsPerSecond
        httpErrorRate = $report.k6.measurements.httpErrorRate
        droppedIterations = $report.k6.measurements.droppedIterations
        acquireMeanMs = $pool.acquire.meanMs; usageMeanMs = $pool.usage.meanMs
        sampledMaxPending = $pool.sampledMaxPending
    }
    Save-Campaign -LastPoint $compact
    if (-not $datasetMatches) { throw 'Dataset differs from the campaign baseline or the point report is missing.' }
    if (-not $poolMatches) { throw 'Actual measured pool maximum differs from the requested pool size.' }
    if (-not $cleanupConfirmed) { throw 'Workload cleanup was not confirmed; stopping before another load can overlap.' }
    if ($report.runner.stopReason -in @('SIGINT', 'SIGTERM')) { throw 'Workload interrupted; stopping the campaign.' }
    if (-not $measurementValid) { throw 'Counter reset, missing metrics, polling failure or invalid point measurement detected.' }
    if ($runExitCode -ne 0 -or $report.status -ne 'completed') {
        if ($Phase -eq 'warmup') { throw 'Timed warmup failed; measured repetitions were not started.' }
        $script:anyLoadFailure = $true
    }
}

Push-Location $repositoryRoot
try {
    $campaign.source = [ordered]@{ commit = (& git rev-parse HEAD); status = @(& git status --short); node = (& node --version) }
    $campaign.datasetBaseline = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 10
    $script:baselineJson = $campaign.datasetBaseline | ConvertTo-Json -Depth 10 -Compress
    foreach ($name in $variableNames) {
        $runningValue = & docker compose exec -T server printenv $name
        if ($LASTEXITCODE -ne 0 -or ([string] $runningValue).Trim() -notmatch '^\d+$') {
            throw "Could not capture the running server setting $name; refusing to change pool settings."
        }
        $originalRunningValues[$name] = ([string] $runningValue).Trim()
    }
    $restoreNeeded = $true
    Save-Campaign
    for ($poolIndex = 0; $poolIndex -lt $Pools.Count; $poolIndex++) {
        $poolSize = $Pools[$poolIndex]
        $env:DB_POOL_SIZE = [string] $poolSize
        $env:DB_POOL_MIN_IDLE = [string] $poolSize
        $env:DB_CONNECTION_TIMEOUT_MS = [string] $ConnectionTimeoutMs
        $env:DB_VALIDATION_TIMEOUT_MS = '500'
        Start-ConfiguredServer
        $warmupCondition = [pscustomobject]@{ id = 'timed-warmup'; model = 'closed'; vus = 20; rate = $null }
        $warmupOrder = if ($poolIndex % 2 -eq 0) { @('v1', 'v2') } else { @('v2', 'v1') }
        for ($position = 0; $position -lt 2; $position++) {
            Invoke-StudyPoint -Phase warmup -PoolSize $poolSize -PoolIndex $poolIndex -Condition $warmupCondition `
                -Repeat 0 -Strategy $warmupOrder[$position] -Order ($position + 1) -ConditionOrder 0 -RunDuration $WarmupDuration
        }
        for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
            for ($position = 0; $position -lt $conditions.Count; $position++) {
                $conditionIndex = ($position + $repeat - 1) % $conditions.Count
                $condition = $conditions[$conditionIndex]
                $order = if (($repeat - 1 + $conditionIndex + $poolIndex) % 2 -eq 0) { @('v1', 'v2') } else { @('v2', 'v1') }
                for ($strategyPosition = 0; $strategyPosition -lt 2; $strategyPosition++) {
                    Invoke-StudyPoint -Phase measure -PoolSize $poolSize -PoolIndex $poolIndex -Condition $condition `
                        -Repeat $repeat -Strategy $order[$strategyPosition] -Order ($strategyPosition + 1) `
                        -ConditionOrder ($position + 1) -RunDuration $Duration
                }
            }
        }
    }
    $campaign.status = if ($anyLoadFailure) { 'completed_with_load_failures' } else { 'completed' }
} catch {
    $campaign.status = 'failed'
    $campaign.error = $_.Exception.Message
    Write-Warning $campaign.error
} finally {
    try {
        foreach ($name in $variableNames) {
            [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process')
        }
        if ($restoreNeeded) {
            foreach ($name in $originalRunningValues.Keys) {
                [Environment]::SetEnvironmentVariable($name, $originalRunningValues[$name], 'Process')
            }
            Start-ConfiguredServer
            $clientId = & docker compose ps --status running -q client
            if ($clientId) {
                & docker compose exec -T client nginx -s reload
                if ($LASTEXITCODE -ne 0) { throw 'Client nginx reload failed after restoring the server.' }
            }
            $campaign.datasetAfter = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 10
            $campaign.datasetUnchanged = (($campaign.datasetAfter | ConvertTo-Json -Depth 10 -Compress) -eq $script:baselineJson)
            if (-not $campaign.datasetUnchanged) { throw 'Dataset differs from the baseline after the campaign.' }
        }
    } catch {
        $campaign.restoreFailed = $true
        $campaign.restoreError = $_.Exception.Message
        Write-Warning "Could not fully restore the initial server: $($_.Exception.Message)"
    } finally {
        foreach ($name in $variableNames) {
            [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process')
        }
        $campaign.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Save-Campaign
        Pop-Location
    }
}

Write-Host "Study reports: $outputPath"
if ($campaign.status -ne 'completed' -or $campaign.restoreFailed) { exit 1 }
