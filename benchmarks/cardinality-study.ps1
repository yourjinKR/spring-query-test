[CmdletBinding()]
param(
    [ValidateSet('sweep', 'confirm')] [string] $Stage = 'confirm',
    [string[]] $Scenarios = @('0/0', '1/1', '5/1', '5/5', '10/5', '20/5', '20/10', '50/10', '50/20', '100/20'),
    [ValidateRange(1, 10)] [int] $Repeats = 5,
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $Duration = '30s',
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $WarmupDuration = '10s',
    [ValidateRange(0, 1000)] [int] $WarmupRequests = 10,
    [switch] $RequireAcPower = $true,
    [string] $BaseUrl = 'http://127.0.0.1:8080',
    [string] $DockerBaseUrl = 'http://server:8080',
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$ids = '1,2,3,4,5,6,7,8,9,10'
$directUrl = 'jdbc:postgresql://db:5432/querylab'
$fixedDataset = [ordered]@{ postCount = 200; bodyBytes = 1024; seed = 42; distribution = 'UNIFORM' }
$settings = @()
foreach ($scenario in $Scenarios) {
    if ($scenario -notmatch '^(\d{1,3})/(\d{1,3})$') { throw "Invalid comments/attachments scenario: $scenario" }
    $comments = [int] $Matches[1]; $attachments = [int] $Matches[2]
    $joinRows = 10 * [Math]::Max(1, $comments) * [Math]::Max(1, $attachments)
    # Same conservative estimate as PostService's safety guard: 1,024 + 512 bytes per JOIN row.
    if ($comments -gt 200 -or $attachments -gt 100 -or $joinRows -gt 250000 -or $joinRows * 1536 -gt 192MB) {
        throw "Scenario $scenario exceeds the application's cardinality/estimated-memory safety limits."
    }
    $settings += [pscustomobject]@{ scenario = "$comments/$attachments"; comments = $comments; attachments = $attachments
        expectedRows = [ordered]@{ v1 = $joinRows; v2 = 10 * (1 + $comments + $attachments) }
        expectedQueryRows = [ordered]@{ v1 = @($joinRows); v2 = @(10, (10 * $comments), (10 * $attachments)) } }
}
if ($settings.Count -eq 0 -or @($settings.scenario | Select-Object -Unique).Count -ne $settings.Count) { throw 'Scenarios must be nonempty and distinct.' }
foreach ($durationText in @($Duration, $WarmupDuration)) {
    $match = [regex]::Match($durationText, '^(\d+)(ms|s|m)$')
    $milliseconds = [double] $match.Groups[1].Value * @{ ms = 1; s = 1000; m = 60000 }[$match.Groups[2].Value]
    if ($milliseconds -lt 1000 -or $milliseconds -gt 600000) { throw 'Duration and WarmupDuration must be between 1s and 10m.' }
}
foreach ($address in @($BaseUrl, $DockerBaseUrl)) {
    $uri = [Uri] $address
    if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo) { throw 'API addresses must be HTTP URLs without credentials.' }
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ("results/cardinality-$Stage-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $outputPath 'campaign.json')) { throw 'OutputDirectory already contains a campaign; choose a new directory.' }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$poolVariables = @('DB_POOL_SIZE', 'DB_POOL_MIN_IDLE', 'DB_CONNECTION_TIMEOUT_MS', 'DB_VALIDATION_TIMEOUT_MS')
$variableNames = $poolVariables + @('COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR')
$originalValues = @{}; $originalRunningValues = @{}
foreach ($name in $variableNames) { $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$points = [System.Collections.Generic.List[object]]::new()
$checks = [System.Collections.Generic.List[object]]::new()
$totalMeasuredRuns = $settings.Count * $Repeats * 2
$restoreNeeded = $false; $datasetTouched = $false; $anyLoadFailure = $false
$cleanupInProgress = $false; $cancellationRequested = $false
$sleepGuardActive = $false; $previousExecutionState = [uint32] 0
$campaign = [ordered]@{
    schemaVersion = 1; experiment = 'cardinality'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); completedAt = $null
    status = 'running'; error = $null; restoreFailed = $false; restoreError = $null; cancellation = $null
    parameters = [ordered]@{ stage = $Stage; scenarios = @($settings.scenario); repeats = $Repeats
        duration = $Duration; warmupDuration = $WarmupDuration; warmupRequests = $WarmupRequests
        fixedDataset = $fixedDataset; ids = @(1..10); route = 'direct'; artificialLatencyMs = 0
        poolSize = 10; minimumIdle = 10; connectionTimeoutMs = 30000; validationTimeoutMs = 500
        model = 'closed'; vus = 1; requestTimeout = '10s'; baseUrl = $BaseUrl; dockerBaseUrl = $DockerBaseUrl
        totalMeasuredRuns = $totalMeasuredRuns; requireAcPowerOnWindows = [bool] $RequireAcPower }
    design = 'Only comments/attachments cardinality changes. Base Compose/direct DB, no proxy. Each repeat rotates scenario order and reverses direction on alternate repeats. AB/BA alternates by scenario and repeat. Every dataset regeneration is followed by separate timed warmups for both strategies, before isolated measured runs. DTO SHA-256 and row/query counts are checked before and after each pair. One execution is one replicate.'
    source = $null; warnings = @(); originalRunningPoolSettings = $originalRunningValues; originalDatabaseUrl = $null
    datasetBaseline = $null; datasetAfter = $null; datasetRestored = $null; originalCorrectness = $null; restoredCorrectness = $null
    power = [ordered]@{ start = $null; end = $null }
    sleepPrevention = [ordered]@{ supported = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
        acquired = $false; restored = $false; previousFlags = $null; acquiredThreadId = $null; restoredThreadId = $null }
    correctnessChecks = @(); points = @()
}

function Write-JsonFile {
    param([string] $Path, [object] $Value)
    [System.IO.File]::WriteAllText(($Path + '.tmp'), (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath ($Path + '.tmp') -Destination $Path -Force
}
function Save-Campaign {
    param([object] $LastPoint = $null)
    $campaign.points = @($points.ToArray()); $campaign.correctnessChecks = @($checks.ToArray())
    Write-JsonFile (Join-Path $outputPath 'campaign.json') $campaign
    Write-JsonFile (Join-Path $outputPath 'progress.json') ([ordered]@{
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o'); stage = $Stage; status = $campaign.status
        measuredCompleted = @($points | Where-Object { $_.phase -eq 'measure' }).Count; measuredTotal = $totalMeasuredRuns
        allPointsCompleted = $points.Count; lastPoint = $LastPoint; error = $campaign.error; restoreFailed = $campaign.restoreFailed })
}
function Assert-NotCancelled {
    param([string] $Boundary)
    if (-not $script:cleanupInProgress -and (Test-Path -LiteralPath (Join-Path $outputPath 'cancel') -PathType Leaf)) {
        $script:cancellationRequested = $true
        $campaign.cancellation = [ordered]@{ observedAt = [DateTimeOffset]::UtcNow.ToString('o'); boundary = $Boundary }
        throw [System.OperationCanceledException]::new("Cancellation requested before $Boundary; restoring initial state.")
    }
}
function Initialize-WindowsInterop {
    if (-not ('QueryLab.CardinalityExecutionState' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace QueryLab {
    public static class CardinalityExecutionState {
        [StructLayout(LayoutKind.Sequential)]
        public struct PowerStatus {
            public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
            public uint BatteryLifeTime, BatteryFullLifeTime;
        }
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint SetThreadExecutionState(uint flags);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetSystemPowerStatus(out PowerStatus status);
    }
}
'@
    }
}
function Get-PowerSnapshot {
    $result = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); supported = $campaign.sleepPrevention.supported
        available = $false; acLineStatus = $null; batteryLifePercent = $null; error = $null }
    if ($result.supported) {
        try {
            Initialize-WindowsInterop
            $native = [QueryLab.CardinalityExecutionState+PowerStatus]::new()
            if (-not [QueryLab.CardinalityExecutionState]::GetSystemPowerStatus([ref] $native)) { throw 'GetSystemPowerStatus failed.' }
            $result.available = $true; $result.acLineStatus = [int] $native.ACLineStatus; $result.batteryLifePercent = [int] $native.BatteryLifePercent
        } catch { $result.error = $_.Exception.Message }
    }
    return $result
}
function Start-ConfiguredServer {
    & docker compose -f compose.yaml up -d --no-deps --wait --wait-timeout 120 server
    if ($LASTEXITCODE -ne 0) { throw 'Server failed to become healthy with the selected settings.' }
}
function Get-DirectRoute {
    $url = & docker compose -f compose.yaml exec -T server printenv DB_URL
    $script:lastObservedRoute = if ($LASTEXITCODE -eq 0) { ([string] $url).Trim() } else { $null }
    return ($LASTEXITCODE -eq 0 -and ([string] $url).Trim() -eq $directUrl)
}
function Test-Dataset {
    param([object] $Dataset, [object] $Setting)
    if ($null -eq $Dataset -or $null -eq $Dataset.config) { return $false }
    $config = $Dataset.config
    return ($Dataset.postCount -eq 200 -and $Dataset.commentCount -eq 200 * $Setting.comments -and $Dataset.attachmentCount -eq 200 * $Setting.attachments -and
        $config.postCount -eq 200 -and $config.commentsPerPost -eq $Setting.comments -and $config.attachmentsPerPost -eq $Setting.attachments -and
        $config.bodyBytes -eq 1024 -and $config.seed -eq 42 -and $config.distribution -eq 'UNIFORM')
}
function Invoke-Correctness {
    param([string] $Name, [object] $Setting = $null, [object] $ExpectedDataset)
    Assert-NotCancelled "correctness $Name"
    $filename = "correctness-$Name.json"; $path = Join-Path $outputPath $filename
    & node benchmarks/compare.mjs --base-url $BaseUrl --ids $ids --warmup 0 --repeats 1 --output $path | Out-Host
    $code = $LASTEXITCODE
    $result = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { $null }
    $expectedJson = $ExpectedDataset | ConvertTo-Json -Depth 10 -Compress
    $valid = ($code -eq 0 -and $result.equalResults -eq $true -and -not $result.error -and @($result.samples).Count -eq 2 -and
        ($result.datasetBefore | ConvertTo-Json -Depth 10 -Compress) -eq $expectedJson -and ($result.datasetAfter | ConvertTo-Json -Depth 10 -Compress) -eq $expectedJson)
    if ($null -ne $Setting) {
        foreach ($sample in @($result.samples)) {
            $expectedQueries = if ($sample.strategy -eq 'v1') { 1 } else { 3 }
            $queryRows = @($sample.metrics.queries | ForEach-Object { $_.rows })
            $expectedQueryRows = @($Setting.expectedQueryRows[$sample.strategy])
            if ($sample.strategy -notin @('v1', 'v2') -or $sample.postCount -ne 10 -or
                $sample.metrics.totalRows -ne $Setting.expectedRows[$sample.strategy] -or $sample.metrics.queryCount -ne $expectedQueries -or
                ($queryRows -join ',') -ne ($expectedQueryRows -join ',')) { $valid = $false }
        }
    }
    $checks.Add([pscustomobject]@{ name = $Name; report = $filename; valid = $valid })
    Save-Campaign
    if (-not $valid) { throw "DTO SHA-256, rows/query counts or dataset check failed: $filename" }
    return $result
}
function Save-Runtime {
    $runtime = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); docker = (& docker version --format '{{json .}}' | ConvertFrom-Json)
        node = (& node --version); containers = @(); power = $campaign.power; sleepPrevention = $campaign.sleepPrevention }
    foreach ($service in @('server', 'db')) {
        $containerId = & docker compose -f compose.yaml ps --status running -q $service
        if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw "Required service not running: $service" }
        $raw = & docker inspect ([string] $containerId).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect $service" }
        $inspection = @($raw -join [Environment]::NewLine | ConvertFrom-Json)[0]
        $runtime.containers += [ordered]@{ service = $service; imageId = $inspection.Image; configuredImage = $inspection.Config.Image
            nanoCpus = $inspection.HostConfig.NanoCpus; memoryBytes = $inspection.HostConfig.Memory; sharedMemoryBytes = $inspection.HostConfig.ShmSize
            javaToolOptions = @($inspection.Config.Env | Where-Object { $_ -like 'JAVA_TOOL_OPTIONS=*' }) }
    }
    Write-JsonFile (Join-Path $outputPath 'runtime.json') $runtime
}
function Invoke-StudyPoint {
    param([string] $Phase, [object] $Setting, [int] $Repeat, [string] $Strategy, [int] $Order, [int] $SettingOrder,
        [string] $RunDuration, [object] $Dataset, [object] $Correctness)
    Assert-NotCancelled "$Phase $($Setting.scenario) $Strategy"
    $filename = "$Phase-$Stage-c-$($Setting.comments)-a-$($Setting.attachments)-repeat-$Repeat-$Strategy.json"
    $reportPath = Join-Path $outputPath $filename
    $arguments = @('benchmarks/pool-run.mjs', '--base-url', $BaseUrl, '--docker-base-url', $DockerBaseUrl,
        '--strategy', $Strategy, '--model', 'closed', '--vus', '1', '--duration', $RunDuration,
        '--warmup', [string] $WarmupRequests, '--ids', $ids, '--request-timeout', '10s', '--output', $reportPath,
        '--expected-rows', [string] $Setting.expectedRows[$Strategy], '--expected-query-rows', (@($Setting.expectedQueryRows[$Strategy]) -join ','))
    $directBefore = Get-DirectRoute
    $routeBefore = $script:lastObservedRoute
    if (-not $directBefore) { throw 'Server DB route is not direct; refusing to launch workload.' }
    Write-Host "$Phase stage=$Stage cardinality=$($Setting.scenario) repeat=$Repeat strategy=$Strategy order=$Order"
    & node @arguments
    $code = $LASTEXITCODE
    $report = if (Test-Path -LiteralPath $reportPath) { Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json } else { $null }
    $datasetJson = $Dataset | ConvertTo-Json -Depth 10 -Compress
    $datasetMatches = ($null -ne $report -and (Test-Dataset $report.datasetBefore $Setting) -and (Test-Dataset $report.datasetAfter $Setting) -and
        ($report.datasetBefore | ConvertTo-Json -Depth 10 -Compress) -eq $datasetJson -and ($report.datasetAfter | ConvertTo-Json -Depth 10 -Compress) -eq $datasetJson)
    $pools = @($report.pools); $pool = if ($pools.Count -eq 1) { $pools[0] } else { $null }
    $poolMatches = ($pools.Count -eq 1 -and $pool.configuredMaximum -eq 10)
    $cleanupConfirmed = ($report.runner.cliTerminated -eq $true -and $report.runner.cleanup.after.status -in @('removed', 'already_absent'))
    $metricsValid = ($poolMatches -and -not $pool.counterReset -and @($pool.missingMetrics).Count -eq 0 -and -not $pool.sampledMaximumChanged -and
        $pool.acquire.histogramAvailable -eq $true -and $pool.usage.histogramAvailable -eq $true)
    $measurementValid = ($null -ne $report.k6 -and $report.pollErrorCount -eq 0 -and $metricsValid -and $report.status -notin @('error', 'measurement_invalid'))
    $rowValues = $report.k6.results.metrics.returned_rows.values
    $rowsMatch = ($null -ne $rowValues -and $rowValues.count -gt 0 -and $rowValues.min -eq $Setting.expectedRows[$Strategy] -and $rowValues.max -eq $Setting.expectedRows[$Strategy])
    $directAfter = Get-DirectRoute
    $routeAfter = $script:lastObservedRoute
    $point = [pscustomobject]@{ phase = $Phase; sequence = $points.Count + 1; stage = $Stage; scenario = $Setting.scenario
        commentsPerPost = $Setting.comments; attachmentsPerPost = $Setting.attachments; route = 'direct'; poolSize = 10; model = 'closed'; vus = 1; rate = $null
        repeat = $Repeat; strategy = $Strategy; order = $Order; settingOrder = $SettingOrder; duration = $RunDuration
        status = $report.status; exitCode = $code; report = $filename; datasetBaseline = $Dataset
        routeBefore = $routeBefore; routeAfter = $routeAfter
        expectedRows = $Setting.expectedRows; expectedQueryRows = $Setting.expectedQueryRows; correctness = $Correctness; correctnessAfter = $null
        validation = [ordered]@{ datasetMatchesExpected = $datasetMatches; poolMatchesExpected = $poolMatches; cleanupConfirmed = $cleanupConfirmed
            measurementValid = $measurementValid; dtoEqual = ($Correctness.equalResults -eq $true); rowsMatchExpected = $rowsMatch; directRoute = ($directBefore -and $directAfter) } }
    $points.Add($point)
    Save-Campaign ([ordered]@{ phase = $Phase; scenario = $Setting.scenario; repeat = $Repeat; strategy = $Strategy; report = $filename; status = $report.status
        httpP95Ms = $report.k6.results.metrics.measured_http_ms.values.'p(95)'; completedRps = $report.k6.measurements.completedRequestsPerSecond })
    if (-not $datasetMatches) { throw 'Dataset differs from expected scenario during load; raw report retained.' }
    if (-not $poolMatches -or -not $directAfter) { throw 'Actual pool/DB route differs from fixed conditions.' }
    if (-not $cleanupConfirmed) { throw 'Workload cleanup unconfirmed; stopping before another workload can overlap.' }
    if ($report.runner.stopReason -in @('SIGINT', 'SIGTERM')) { throw 'Workload interrupted; stopping campaign.' }
    if (-not $measurementValid) { throw 'Missing metrics, polling failure, counter reset or invalid point measurement; raw report retained.' }
    if (-not $rowsMatch) { throw 'Measured returned_rows differs from expected scenario; investigate before continuing.' }
    $loadFailure = ($code -ne 0 -or $report.status -ne 'completed' -or $report.k6.measurements.httpErrorRate -gt 0 -or
        $report.k6.measurements.contractErrorRate -gt 0 -or $report.k6.measurements.droppedIterations -gt 0 -or
        $report.k6.measurements.incompleteRequests -gt 0 -or $pool.timeoutCount -gt 0)
    if ($loadFailure) {
        if ($Phase -eq 'warmup') { throw 'Timed warmup failed; measured pair not started.' }
        $script:anyLoadFailure = $true
    }
}

Push-Location $repositoryRoot
try {
    # pool-run inherits only the base Compose path. A caller's latency overlay cannot leak into k6 launches.
    $env:COMPOSE_FILE = Join-Path $repositoryRoot 'compose.yaml'; $env:COMPOSE_PATH_SEPARATOR = ';'
    $campaign.source = [ordered]@{ commit = (& git rev-parse HEAD); status = @(& git status --short); node = (& node --version) }
    Save-Campaign
    Assert-NotCancelled 'startup'
    $campaign.power.start = Get-PowerSnapshot
    if ($campaign.power.start.supported -and $RequireAcPower -and (-not $campaign.power.start.available -or $campaign.power.start.acLineStatus -ne 1)) {
        throw 'AC power required. Connect AC power or explicitly pass -RequireAcPower:$false for an intentional battery run.'
    }
    if ($campaign.sleepPrevention.supported) {
        Initialize-WindowsInterop
        $previousExecutionState = [QueryLab.CardinalityExecutionState]::SetThreadExecutionState([uint32] 2147483649)
        if ($previousExecutionState -eq 0) { throw 'Could not establish temporary Windows sleep prevention.' }
        $sleepGuardActive = $true; $campaign.sleepPrevention.acquired = $true; $campaign.sleepPrevention.previousFlags = $previousExecutionState
        $campaign.sleepPrevention.acquiredThreadId = [QueryLab.CardinalityExecutionState]::GetCurrentThreadId()
    }
    if (-not (Get-DirectRoute)) { throw 'Initial server DB_URL must be jdbc:postgresql://db:5432/querylab. Restore the base Compose/direct route before this campaign.' }
    $campaign.originalDatabaseUrl = $directUrl
    $campaign.datasetBaseline = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 30
    if ($null -eq $campaign.datasetBaseline.config) { throw 'Initial dataset must have a stored seed configuration to support restoration.' }
    $initialDatasetJson = $campaign.datasetBaseline | ConvertTo-Json -Depth 10 -Compress
    $campaign.originalCorrectness = Invoke-Correctness 'original' -ExpectedDataset $campaign.datasetBaseline
    foreach ($name in $poolVariables) {
        $value = & docker compose -f compose.yaml exec -T server printenv $name
        if ($LASTEXITCODE -ne 0 -or ([string] $value).Trim() -notmatch '^\d+$') { throw "Could not capture running $name; refusing to modify settings." }
        $originalRunningValues[$name] = ([string] $value).Trim()
    }
    $restoreNeeded = $true
    $env:DB_POOL_SIZE = '10'; $env:DB_POOL_MIN_IDLE = '10'; $env:DB_CONNECTION_TIMEOUT_MS = '30000'; $env:DB_VALIDATION_TIMEOUT_MS = '500'
    Start-ConfiguredServer
    Save-Runtime
    Save-Campaign
    for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
        for ($position = 0; $position -lt $settings.Count; $position++) {
            $direction = if ($repeat % 2 -eq 1) { 1 } else { -1 }
            $settingIndex = (($repeat - 1 + $direction * $position) % $settings.Count + $settings.Count) % $settings.Count
            $setting = $settings[$settingIndex]
            Assert-NotCancelled "dataset regeneration $($setting.scenario) repeat $repeat"
            $config = [ordered]@{ postCount = 200; commentsPerPost = $setting.comments; attachmentsPerPost = $setting.attachments; bodyBytes = 1024; seed = 42; distribution = 'UNIFORM' }
            $datasetTouched = $true
            $dataset = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -Method Post -ContentType 'application/json' -Body ($config | ConvertTo-Json) -TimeoutSec 120
            Write-JsonFile (Join-Path $outputPath "dataset-c-$($setting.comments)-a-$($setting.attachments)-repeat-$repeat.json") $dataset
            if (-not (Test-Dataset $dataset $setting)) { throw 'Dataset regeneration produced unexpected config/counts.' }
            $correctness = Invoke-Correctness "c-$($setting.comments)-a-$($setting.attachments)-repeat-$repeat-before" $setting $dataset
            $order = if (($repeat - 1 + $settingIndex) % 2 -eq 0) { @('v1', 'v2') } else { @('v2', 'v1') }
            for ($index = 0; $index -lt 2; $index++) {
                Invoke-StudyPoint warmup $setting $repeat $order[$index] ($index + 1) ($position + 1) $WarmupDuration $dataset $correctness
            }
            $pairPoints = [System.Collections.Generic.List[object]]::new()
            for ($index = 0; $index -lt 2; $index++) {
                Invoke-StudyPoint measure $setting $repeat $order[$index] ($index + 1) ($position + 1) $Duration $dataset $correctness
                $pairPoints.Add($points[$points.Count - 1])
            }
            try {
                $after = Invoke-Correctness "c-$($setting.comments)-a-$($setting.attachments)-repeat-$repeat-after" $setting $dataset
                if ($after.samples[0].postsSha256 -ne $correctness.samples[0].postsSha256) { throw 'DTO SHA-256 changed across measured pair.' }
                foreach ($point in $pairPoints) { $point.correctnessAfter = $after }
            } catch {
                foreach ($point in $pairPoints) { $point.validation.dtoEqual = $false; $point.validation.rowsMatchExpected = $false }
                Save-Campaign
                throw
            }
            Save-Campaign
        }
    }
    $campaign.status = if ($anyLoadFailure) { 'completed_with_load_failures' } else { 'completed' }
} catch {
    $campaign.status = if ($cancellationRequested) { 'aborted' } else { 'failed' }; $campaign.error = $_.Exception.Message
    Write-Warning $campaign.error
} finally {
    $cleanupInProgress = $true
    $restoreErrors = [System.Collections.Generic.List[string]]::new()
    if ($datasetTouched) {
        try {
            $restored = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -Method Post -ContentType 'application/json' -Body ($campaign.datasetBaseline.config | ConvertTo-Json) -TimeoutSec 120
            $campaign.datasetAfter = $restored
            $campaign.datasetRestored = (($restored | ConvertTo-Json -Depth 10 -Compress) -eq $initialDatasetJson)
            if (-not $campaign.datasetRestored) { throw 'Original dataset configuration/counts not restored.' }
            $campaign.restoredCorrectness = Invoke-Correctness 'restored' -ExpectedDataset $restored
            if ($campaign.restoredCorrectness.samples[0].postsSha256 -ne $campaign.originalCorrectness.samples[0].postsSha256) { throw 'Original DTO SHA-256 not restored.' }
        } catch { $restoreErrors.Add("Dataset restoration: $($_.Exception.Message)") }
    }
    if ($restoreNeeded) {
        try {
            foreach ($name in $poolVariables) { [Environment]::SetEnvironmentVariable($name, $originalRunningValues[$name], 'Process') }
            Start-ConfiguredServer
            if (-not (Get-DirectRoute)) { throw 'Original direct DB route not restored.' }
            foreach ($name in $poolVariables) {
                $value = & docker compose -f compose.yaml exec -T server printenv $name
                if ($LASTEXITCODE -ne 0 -or ([string] $value).Trim() -ne $originalRunningValues[$name]) { throw "Original $name not restored." }
            }
            $clientId = & docker compose -f compose.yaml ps --status running -q client
            if ($clientId) {
                & docker compose -f compose.yaml exec -T client nginx -s reload
                if ($LASTEXITCODE -ne 0) { throw 'Client nginx reload failed after server restoration.' }
            }
        } catch { $restoreErrors.Add("Server restoration: $($_.Exception.Message)") }
    }
    $campaign.power.end = Get-PowerSnapshot
    if ($sleepGuardActive) {
        try {
            $campaign.sleepPrevention.restoredThreadId = [QueryLab.CardinalityExecutionState]::GetCurrentThreadId()
            $result = [QueryLab.CardinalityExecutionState]::SetThreadExecutionState($previousExecutionState)
            if ($result -eq 0 -or $campaign.sleepPrevention.restoredThreadId -ne $campaign.sleepPrevention.acquiredThreadId) { throw 'Sleep prevention restoration failed or ran on a different thread.' }
            $campaign.sleepPrevention.restored = $true
        } catch { $restoreErrors.Add("Sleep prevention: $($_.Exception.Message)") }
    }
    if ($restoreErrors.Count -gt 0) { $campaign.restoreFailed = $true; $campaign.restoreError = $restoreErrors -join '; '; Write-Warning $campaign.restoreError }
    foreach ($name in $variableNames) { [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process') }
    $campaign.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Campaign
    Pop-Location
}
Write-Host "Cardinality reports: $outputPath"
if ($campaign.status -ne 'completed' -or $campaign.restoreFailed) { exit 1 }
