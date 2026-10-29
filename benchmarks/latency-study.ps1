[CmdletBinding()]
param(
    [ValidateSet('baseline', 'sweep', 'refine', 'load')] [string] $Stage = 'sweep',
    [Alias('PoolSizes')] [int[]] $Pools,
    [int[]] $RttMs,
    [ValidateRange(1, 10)] [int] $Repeats = 5,
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $Duration = '30s',
    [ValidatePattern('^\d+(ms|s|m)$')] [string] $WarmupDuration = '10s',
    [ValidateRange(0, 1000)] [int] $WarmupRequests = 10,
    [ValidateRange(1, 200)] [int] $LoadVus = 20,
    [ValidateRange(0, 5000)] [int] $ArrivalRate = 0,
    [ValidateRange(1, 500)] [int] $PreallocatedVus = 50,
    [ValidateRange(1, 500)] [int] $MaxVus = 200,
    [ValidateRange(1000, 30000)] [int] $ConnectionTimeoutMs = 1000,
    [ValidateRange(10, 1000)] [int] $CalibrationSamples = 30,
    [switch] $RequireAcPower = $true,
    [string] $Ids = '1,2,3,4,5,6,7,8,9,10',
    [string] $BaseUrl = 'http://127.0.0.1:8080',
    [string] $DockerBaseUrl = 'http://server:8080',
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $PSBoundParameters.ContainsKey('Pools')) { $Pools = if ($Stage -eq 'load') { @(2, 10) } else { @(10) } }
if (-not $PSBoundParameters.ContainsKey('RttMs')) {
    $RttMs = switch ($Stage) { 'baseline' { @(0) }; 'load' { @(0, 5, 20) }; default { @(0, 1, 2, 5, 10, 20, 50) } }
}
if ($Pools.Count -eq 0 -or @($Pools | Where-Object { $_ -lt 1 -or $_ -gt 32 }).Count -gt 0 -or @($Pools | Select-Object -Unique).Count -ne $Pools.Count) {
    throw 'Pools must contain distinct values from 1 through 32.'
}
if ($RttMs.Count -eq 0 -or @($RttMs | Where-Object { $_ -lt 0 -or $_ -gt 1000 }).Count -gt 0 -or @($RttMs | Select-Object -Unique).Count -ne $RttMs.Count) {
    throw 'RttMs must contain distinct integer added-round-trip delays from 0 through 1000 ms.'
}
if ($Stage -eq 'baseline' -and ($RttMs.Count -ne 1 -or $RttMs[0] -ne 0)) { throw 'The direct/proxy baseline requires RttMs 0.' }
if ($Stage -ne 'load' -and $ArrivalRate -ne 0) { throw 'ArrivalRate is only supported by the load stage; zero disables that condition.' }
if ($PreallocatedVus -gt $MaxVus) { throw 'PreallocatedVus must not exceed MaxVus.' }
if ($Ids -ne '1,2,3,4,5,6,7,8,9,10') { throw 'This campaign keeps the previous study ID set 1 through 10 fixed.' }
foreach ($durationText in @($Duration, $WarmupDuration)) {
    $durationMatch = [regex]::Match($durationText, '^(\d+)(ms|s|m)$')
    $durationMultiplier = @{ ms = 1; s = 1000; m = 60000 }[$durationMatch.Groups[2].Value]
    $durationMilliseconds = [double] $durationMatch.Groups[1].Value * $durationMultiplier
    if ($durationMilliseconds -lt 1000 -or $durationMilliseconds -gt 600000) { throw 'Duration and WarmupDuration must be between 1s and 10m.' }
}
foreach ($address in @($BaseUrl, $DockerBaseUrl)) {
    $uri = [Uri] $address
    if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo) { throw 'API addresses must be HTTP URLs without credentials.' }
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ("results/latency-$Stage-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $outputPath 'campaign.json')) { throw 'OutputDirectory already contains a campaign; choose a new directory.' }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$script:composeArguments = @('compose', '-f', 'compose.yaml', '-f', 'compose.latency.yaml')
$poolVariables = @('DB_POOL_SIZE', 'DB_POOL_MIN_IDLE', 'DB_CONNECTION_TIMEOUT_MS', 'DB_VALIDATION_TIMEOUT_MS')
$variableNames = $poolVariables + @('LATENCY_DB_URL', 'COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR')
$originalValues = @{}
$originalRunningValues = @{}
foreach ($name in $variableNames) { $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$points = [System.Collections.Generic.List[object]]::new()
$calibrations = [System.Collections.Generic.List[object]]::new()
$correctnessChecks = [System.Collections.Generic.List[object]]::new()
$conditions = @([pscustomobject]@{ id = if ($Stage -eq 'load') { "closed-vus-$LoadVus" } else { 'closed-vus-1' }; model = 'closed'; vus = if ($Stage -eq 'load') { $LoadVus } else { 1 }; rate = $null })
if ($Stage -eq 'load' -and $ArrivalRate -gt 0) { $conditions += [pscustomobject]@{ id = "arrival-rate-$ArrivalRate"; model = 'arrival'; vus = $null; rate = $ArrivalRate } }
$routes = if ($Stage -eq 'baseline') { @('direct', 'proxy') } else { @('proxy') }
$settings = @()
foreach ($route in $routes) { foreach ($delayMs in $RttMs) { $settings += [pscustomobject]@{ route = $route; rttMs = $delayMs } } }
$totalMeasuredRuns = $Pools.Count * $settings.Count * $Repeats * $conditions.Count * 2
$restoreNeeded = $false
$proxyTouched = $false
$anyLoadFailure = $false
$originalDatabaseUrl = $null
$script:currentServerKey = $null
$script:serverGeneration = 0
$script:cleanupInProgress = $false
$script:cancellationRequested = $false
$script:sleepGuardActive = $false
$script:previousExecutionState = [uint32] 0
$cancelPath = Join-Path $outputPath 'cancel'
$campaign = [ordered]@{
    schemaVersion = 1; experiment = 'latency'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); completedAt = $null
    status = 'running'; error = $null; restoreFailed = $false; restoreError = $null
    parameters = [ordered]@{
        stage = $Stage; pools = $Pools; rttMs = $RttMs; routes = $routes; repeats = $Repeats
        duration = $Duration; warmupDuration = $WarmupDuration; warmupRequests = $WarmupRequests
        loadVus = $LoadVus; arrivalRate = $ArrivalRate; preallocatedVus = $PreallocatedVus; maxVus = $MaxVus
        connectionTimeoutMs = $ConnectionTimeoutMs; validationTimeoutMs = 500; requestTimeout = '10s'
        calibrationSamples = $CalibrationSamples; ids = $Ids; baseUrl = $BaseUrl; dockerBaseUrl = $DockerBaseUrl
        requireAcPowerOnWindows = [bool] $RequireAcPower
        totalMeasuredRuns = $totalMeasuredRuns
    }
    design = 'Sequential isolated strategy runs. Added RTT is split floor/ceil upstream/downstream, jitter zero; zero-delay directions have no toxic. Settings rotate across repetitions; strategy AB/BA alternates. Timed warmups occur at the first encounter of each pool/route/RTT/condition in every server generation, including after route restarts; sequential request warmup precedes every run. One complete run is the replication unit.'
    source = $null; originalRunningPoolSettings = $originalRunningValues; warnings = @(); cancellation = $null
    power = [ordered]@{ requireAcPowerOnWindows = [bool] $RequireAcPower; startupCheckPassed = $false; start = $null; end = $null }
    sleepPrevention = [ordered]@{
        platform = [Environment]::OSVersion.Platform.ToString(); api = 'SetThreadExecutionState'
        supported = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
        requestedFlags = [uint32] 2147483649; requestedFlagNames = 'ES_CONTINUOUS|ES_SYSTEM_REQUIRED'
        displayRequired = $false; acquired = $false; acquiredAt = $null; acquiredThreadId = $null
        previousFlags = $null; restored = $false; restoredAt = $null; restoredThreadId = $null
        note = 'Temporary thread-scoped idle-sleep prevention during this process only; no power-plan change. Windows releases the request if the process exits.'
    }
    datasetBaseline = $null; datasetAfter = $null; datasetUnchanged = $null; calibrations = @(); correctnessChecks = @(); points = @()
}

function Assert-CampaignNotCancelled {
    param([string] $Boundary)
    if (-not $script:cleanupInProgress -and (Test-Path -LiteralPath $cancelPath -PathType Leaf)) {
        $script:cancellationRequested = $true
        if ($null -eq $campaign.cancellation) {
            $campaign.cancellation = [ordered]@{ marker = 'cancel'; observedAt = [DateTimeOffset]::UtcNow.ToString('o'); boundary = $Boundary }
        }
        throw [System.OperationCanceledException]::new("Campaign cancellation requested by the cancel marker before $Boundary; restoring the initial state.")
    }
}

function Initialize-CampaignWindowsInterop {
    if (-not ('QueryLab.LatencyExecutionState' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace QueryLab {
    public static class LatencyExecutionState {
        [StructLayout(LayoutKind.Sequential)]
        public struct PowerStatus {
            public byte ACLineStatus;
            public byte BatteryFlag;
            public byte BatteryLifePercent;
            public byte SystemStatusFlag;
            public uint BatteryLifeTime;
            public uint BatteryFullLifeTime;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint flags);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetSystemPowerStatus(out PowerStatus status);
    }
}
'@
    }
}

function Get-CampaignPowerSnapshot {
    $snapshot = [ordered]@{
        recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
        supported = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
        available = $false; acLineStatus = $null; batteryFlag = $null; batteryLifePercent = $null; error = $null
    }
    if (-not $snapshot.supported) { return $snapshot }
    try {
        Initialize-CampaignWindowsInterop
        $nativePower = [QueryLab.LatencyExecutionState+PowerStatus]::new()
        $success = [QueryLab.LatencyExecutionState]::GetSystemPowerStatus([ref] $nativePower)
        if (-not $success) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "GetSystemPowerStatus failed (Win32 error $nativeError)."
        }
        $snapshot.available = $true
        $snapshot.acLineStatus = [int] $nativePower.ACLineStatus
        $snapshot.batteryFlag = [int] $nativePower.BatteryFlag
        $snapshot.batteryLifePercent = [int] $nativePower.BatteryLifePercent
    } catch { $snapshot.error = $_.Exception.Message }
    return $snapshot
}

function Enable-CampaignSleepPrevention {
    if (-not $campaign.sleepPrevention.supported) { return }
    Initialize-CampaignWindowsInterop
    $previousState = [QueryLab.LatencyExecutionState]::SetThreadExecutionState([uint32] 2147483649)
    if ($previousState -eq 0) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Could not establish temporary Windows sleep prevention (Win32 error $nativeError)."
    }
    $script:previousExecutionState = [uint32] $previousState
    $script:sleepGuardActive = $true
    $campaign.sleepPrevention.acquired = $true
    $campaign.sleepPrevention.previousFlags = [uint32] $previousState
    $campaign.sleepPrevention.acquiredAt = [DateTimeOffset]::UtcNow.ToString('o')
    $campaign.sleepPrevention.acquiredThreadId = [QueryLab.LatencyExecutionState]::GetCurrentThreadId()
}

function Restore-CampaignSleepPrevention {
    if (-not $script:sleepGuardActive) { return }
    $currentThreadId = [QueryLab.LatencyExecutionState]::GetCurrentThreadId()
    $restoreResult = [QueryLab.LatencyExecutionState]::SetThreadExecutionState($script:previousExecutionState)
    if ($restoreResult -eq 0) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Could not restore the previous Windows execution state (Win32 error $nativeError)."
    }
    $campaign.sleepPrevention.restoredThreadId = $currentThreadId
    if ($currentThreadId -ne $campaign.sleepPrevention.acquiredThreadId) {
        throw 'Windows sleep-prevention restoration ran on a different thread; the original request will be released when this process exits.'
    }
    $script:sleepGuardActive = $false
    $campaign.sleepPrevention.restored = $true
    $campaign.sleepPrevention.restoredAt = [DateTimeOffset]::UtcNow.ToString('o')
}

function Write-JsonFile {
    param([string] $Path, [object] $Value)
    $temporaryPath = $Path + '.tmp'
    $json = $Value | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Save-Campaign {
    param([object] $LastPoint = $null)
    $campaign.points = @($points.ToArray())
    $campaign.calibrations = @($calibrations.ToArray())
    $campaign.correctnessChecks = @($correctnessChecks.ToArray())
    Write-JsonFile -Path (Join-Path $outputPath 'campaign.json') -Value $campaign
    Write-JsonFile -Path (Join-Path $outputPath 'progress.json') -Value ([ordered]@{
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o'); stage = $Stage; status = $campaign.status
        measuredCompleted = @($campaign.points | Where-Object { $_.phase -eq 'measure' }).Count
        measuredTotal = $totalMeasuredRuns; allPointsCompleted = $points.Count
        lastPoint = $LastPoint; error = $campaign.error; restoreFailed = $campaign.restoreFailed
    })
}

function Invoke-Control {
    param([string[]] $ControlArguments)
    Assert-CampaignNotCancelled -Boundary ('Toxiproxy control ' + ($ControlArguments -join ' '))
    $raw = & docker @script:composeArguments run --rm --no-deps -T toxiproxy-control @ControlArguments
    if ($LASTEXITCODE -ne 0) { throw "Toxiproxy Java control failed: $($ControlArguments -join ' ')" }
    try { return ($raw -join [Environment]::NewLine) | ConvertFrom-Json }
    catch { throw 'Toxiproxy Java control returned invalid JSON.' }
}

function Assert-Proxy {
    param([object] $Snapshot, [int] $AddedRttMs)
    $proxy = $Snapshot.proxy
    if ($null -eq $proxy -or $proxy.name -ne 'querylab-postgres' -or $proxy.enabled -ne $true -or $proxy.upstream -ne 'db:5432' -or $proxy.listen -notin @('0.0.0.0:8666', '[::]:8666')) {
        throw 'Proxy identity, endpoint or enabled state differs from the experiment route.'
    }
    $expected = @{ upstream = [int] [Math]::Floor($AddedRttMs / 2.0); downstream = [int] [Math]::Ceiling($AddedRttMs / 2.0) }
    foreach ($toxic in @($proxy.toxics)) {
        if ($toxic.name -notin @('querylab-rtt-upstream', 'querylab-rtt-downstream') -or $toxic.type -ne 'latency' -or
            $toxic.stream -notin @('upstream', 'downstream') -or $toxic.name -ne ('querylab-rtt-' + $toxic.stream) -or
            $toxic.toxicity -ne 1 -or $toxic.jitterMs -ne 0 -or $toxic.latencyMs -ne $expected[$toxic.stream]) {
            throw 'Unexpected toxic or latency/jitter/toxicity configuration; refusing a mixed experiment.'
        }
    }
    foreach ($stream in @('upstream', 'downstream')) {
        $streamToxics = @($proxy.toxics | Where-Object { $_.stream -eq $stream })
        if (($expected[$stream] -eq 0 -and $streamToxics.Count -ne 0) -or ($expected[$stream] -gt 0 -and $streamToxics.Count -ne 1)) {
            throw "Missing, duplicate or unexpected zero-delay $stream latency toxic."
        }
    }
}

function Start-ConfiguredServer {
    Assert-CampaignNotCancelled -Boundary 'server configuration/restart'
    & docker @script:composeArguments up -d --no-deps --wait --wait-timeout 120 server
    if ($LASTEXITCODE -ne 0) { throw 'Server failed to become healthy with selected database and pool settings.' }
}

function Set-ServerRoute {
    param([int] $PoolSize, [string] $Route)
    $serverKey = "$PoolSize/$Route"
    if ($script:currentServerKey -eq $serverKey) { return }
    $env:DB_POOL_SIZE = [string] $PoolSize
    $env:DB_POOL_MIN_IDLE = [string] $PoolSize
    $env:DB_CONNECTION_TIMEOUT_MS = [string] $ConnectionTimeoutMs
    $env:DB_VALIDATION_TIMEOUT_MS = '500'
    $env:LATENCY_DB_URL = if ($Route -eq 'direct') { 'jdbc:postgresql://db:5432/querylab' } else { 'jdbc:postgresql://toxiproxy:8666/querylab' }
    Start-ConfiguredServer
    $actualUrl = & docker @script:composeArguments exec -T server printenv DB_URL
    if ($LASTEXITCODE -ne 0 -or ([string] $actualUrl).Trim() -ne $env:LATENCY_DB_URL) { throw 'Server DB_URL does not match the selected route.' }
    $script:currentServerKey = $serverKey
    $script:serverGeneration++
}

function Assert-Dataset {
    param([object] $Dataset)
    $config = $Dataset.config
    if ($Dataset.postCount -ne 200 -or $Dataset.commentCount -ne 4000 -or $Dataset.attachmentCount -ne 1000 -or
        $config.postCount -ne 200 -or $config.commentsPerPost -ne 20 -or $config.attachmentsPerPost -ne 5 -or
        $config.bodyBytes -ne 1024 -or $config.seed -ne 42 -or $config.distribution -ne 'UNIFORM') {
        throw 'Dataset does not match the previous 200/20/5/1024-byte/seed-42 UNIFORM study. It was not regenerated.'
    }
}

function Save-Runtime {
    $runtime = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); containers = @(); powerAtStart = $campaign.power.start; sleepPrevention = $campaign.sleepPrevention }
    foreach ($service in @('server', 'db', 'toxiproxy')) {
        $containerId = & docker @script:composeArguments ps --status running -q $service
        if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw "Required service is not running: $service" }
        $inspectionText = & docker inspect ([string] $containerId).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect runtime service $service" }
        $inspection = @($inspectionText -join [Environment]::NewLine | ConvertFrom-Json)[0]
        $runtime.containers += [ordered]@{
            service = $service; imageId = $inspection.Image; configuredImage = $inspection.Config.Image
            nanoCpus = $inspection.HostConfig.NanoCpus; memoryBytes = $inspection.HostConfig.Memory
            sharedMemoryBytes = $inspection.HostConfig.ShmSize
            javaToolOptions = @($inspection.Config.Env | Where-Object { $_ -like 'JAVA_TOOL_OPTIONS=*' })
        }
    }
    Write-JsonFile -Path (Join-Path $outputPath 'runtime.json') -Value $runtime
}

function Invoke-StudyPoint {
    param([string] $Phase, [int] $PoolSize, [int] $PoolIndex, [object] $Setting, [object] $Condition,
        [int] $Repeat, [string] $Strategy, [int] $Order, [int] $SettingOrder, [string] $RunDuration)
    Assert-CampaignNotCancelled -Boundary "$Phase $Strategy run"
    $filename = "$Phase-$Stage-$($Setting.route)-rtt-$($Setting.rttMs)-pool-$PoolSize-$($Condition.id)-repeat-$Repeat-$Strategy.json"
    $reportPath = Join-Path $outputPath $filename
    $arguments = @('benchmarks/pool-run.mjs', '--base-url', $BaseUrl, '--docker-base-url', $DockerBaseUrl,
        '--strategy', $Strategy, '--model', $Condition.model, '--duration', $RunDuration,
        '--warmup', [string] $WarmupRequests, '--ids', $Ids, '--request-timeout', '10s', '--output', $reportPath)
    if ($Condition.model -eq 'arrival') { $arguments += @('--rate', [string] $Condition.rate, '--preallocated-vus', [string] $PreallocatedVus, '--max-vus', [string] $MaxVus) }
    else { $arguments += @('--vus', [string] $Condition.vus) }
    $proxyBefore = Invoke-Control -ControlArguments @('inspect')
    Assert-Proxy -Snapshot $proxyBefore -AddedRttMs $Setting.rttMs
    Write-Host "$Phase stage=$Stage route=$($Setting.route) addedRTT=$($Setting.rttMs)ms pool=$PoolSize condition=$($Condition.id) repeat=$Repeat strategy=$Strategy order=$Order"
    Assert-CampaignNotCancelled -Boundary "$Phase $Strategy workload launch"
    & node @arguments
    $runExitCode = $LASTEXITCODE
    $report = if (Test-Path -LiteralPath $reportPath) { Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json } else { $null }
    $proxyAfter = $null
    $proxyValidationError = $null
    try {
        $proxyAfter = Invoke-Control -ControlArguments @('inspect')
        Assert-Proxy -Snapshot $proxyAfter -AddedRttMs $Setting.rttMs
    } catch { $proxyValidationError = $_.Exception.Message }
    $beforeJson = $report.datasetBefore | ConvertTo-Json -Depth 10 -Compress
    $afterJson = $report.datasetAfter | ConvertTo-Json -Depth 10 -Compress
    $datasetMatches = ($null -ne $report -and $beforeJson -eq $script:baselineJson -and $afterJson -eq $script:baselineJson)
    $actualPools = @($report.pools)
    $poolMatches = ($actualPools.Count -eq 1 -and $actualPools[0].configuredMaximum -eq $PoolSize)
    $cleanupConfirmed = ($report.runner.cliTerminated -eq $true -and @('removed', 'already_absent') -contains $report.runner.cleanup.after.status)
    $poolMetricsValid = ($actualPools.Count -eq 1 -and -not $actualPools[0].counterReset -and @($actualPools[0].missingMetrics).Count -eq 0 -and
        -not $actualPools[0].sampledMaximumChanged -and $actualPools[0].acquire.histogramAvailable -eq $true -and $actualPools[0].usage.histogramAvailable -eq $true)
    $measurementValid = ($null -ne $report.k6 -and $report.pollErrorCount -eq 0 -and $poolMetricsValid -and -not $proxyValidationError -and $report.status -notin @('error', 'measurement_invalid'))
    $point = [pscustomobject]@{
        phase = $Phase; sequence = $points.Count + 1; stage = $Stage; route = $Setting.route; rttMs = $Setting.rttMs
        poolSize = $PoolSize; poolIndex = $PoolIndex; serverGeneration = $script:serverGeneration; model = $Condition.model; vus = $Condition.vus; rate = $Condition.rate
        condition = $Condition.id; repeat = $Repeat; strategy = $Strategy; order = $Order; settingOrder = $SettingOrder
        duration = $RunDuration; status = $report.status; exitCode = $runExitCode; report = $filename
        proxyBefore = $proxyBefore.proxy; proxyAfter = $proxyAfter.proxy
        proxyValidationError = $proxyValidationError
        validation = [ordered]@{ datasetMatchesBaseline = $datasetMatches; poolMatchesExpected = $poolMatches; cleanupConfirmed = $cleanupConfirmed; measurementValid = $measurementValid; proxyMatchesExpected = -not $proxyValidationError }
    }
    $points.Add($point)
    $pool = if ($actualPools.Count -eq 1) { $actualPools[0] } else { $null }
    Save-Campaign -LastPoint ([ordered]@{
        phase = $Phase; stage = $Stage; route = $Setting.route; rttMs = $Setting.rttMs; poolSize = $PoolSize
        condition = $Condition.id; repeat = $Repeat; strategy = $Strategy; status = $report.status; report = $filename
        httpP95Ms = $report.k6.results.metrics.measured_http_ms.values.'p(95)'; completedRps = $report.k6.measurements.completedRequestsPerSecond
        httpErrorRate = $report.k6.measurements.httpErrorRate; droppedIterations = $report.k6.measurements.droppedIterations
        acquireMeanMs = $pool.acquire.meanMs; usageMeanMs = $pool.usage.meanMs; sampledMaxPending = $pool.sampledMaxPending
    })
    if (-not $datasetMatches) { throw 'Dataset differs from the campaign baseline or the point report is missing.' }
    if (-not $poolMatches) { throw 'Actual pool maximum differs from the requested size.' }
    if (-not $cleanupConfirmed) { throw 'Workload cleanup unconfirmed; stopping before another workload can overlap.' }
    if ($report.runner.stopReason -in @('SIGINT', 'SIGTERM')) { throw 'Workload interrupted; stopping campaign.' }
    if ($proxyValidationError) { throw $proxyValidationError }
    if (-not $measurementValid) { throw 'Missing metrics, polling failure, counter reset or invalid point measurement detected.' }
    $loadFailure = $runExitCode -ne 0 -or $report.status -ne 'completed' -or $report.k6.measurements.httpErrorRate -gt 0 -or
        $report.k6.measurements.droppedIterations -gt 0 -or $report.k6.measurements.incompleteRequests -gt 0 -or $pool.timeoutCount -gt 0
    if ($loadFailure) {
        if ($Phase -eq 'warmup') { throw 'Timed warmup failed; measured run not started.' }
        $script:anyLoadFailure = $true
    }
}

Push-Location $repositoryRoot
try {
    $env:COMPOSE_PATH_SEPARATOR = ';'
    $env:COMPOSE_FILE = (Join-Path $repositoryRoot 'compose.yaml') + ';' + (Join-Path $repositoryRoot 'compose.latency.yaml')
    $campaign.source = [ordered]@{ commit = (& git rev-parse HEAD); status = @(& git status --short); node = (& node --version) }
    Save-Campaign
    Assert-CampaignNotCancelled -Boundary 'campaign startup'
    $campaign.power.start = Get-CampaignPowerSnapshot
    if ($campaign.power.start.supported -and $RequireAcPower -and (-not $campaign.power.start.available -or $campaign.power.start.acLineStatus -ne 1)) {
        throw 'AC power is required before this Windows benchmark can start. Connect AC power or explicitly pass -RequireAcPower:$false for an intentional battery run.'
    }
    $campaign.power.startupCheckPassed = $true
    Enable-CampaignSleepPrevention
    Save-Campaign
    $campaign.datasetBaseline = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 10
    Assert-Dataset -Dataset $campaign.datasetBaseline
    $script:baselineJson = $campaign.datasetBaseline | ConvertTo-Json -Depth 10 -Compress
    foreach ($name in $poolVariables) {
        $runningValue = & docker @script:composeArguments exec -T server printenv $name
        if ($LASTEXITCODE -ne 0 -or ([string] $runningValue).Trim() -notmatch '^\d+$') { throw "Could not capture running $name; refusing to change the server." }
        $originalRunningValues[$name] = ([string] $runningValue).Trim()
    }
    $urlValue = & docker @script:composeArguments exec -T server printenv DB_URL
    if ($LASTEXITCODE -ne 0 -or -not $urlValue) { throw 'Could not capture the running DB_URL; refusing to change the server.' }
    $originalDatabaseUrl = ([string] $urlValue).Trim()
    $restoreNeeded = $true
    $proxyTouched = $true
    $initialProxy = Invoke-Control -ControlArguments @('set', '0')
    Assert-Proxy -Snapshot $initialProxy -AddedRttMs 0
    Save-Runtime
    Save-Campaign
    $warmedConditions = @{}
    for ($poolIndex = 0; $poolIndex -lt $Pools.Count; $poolIndex++) {
        $poolSize = $Pools[$poolIndex]
        for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
            for ($position = 0; $position -lt $settings.Count; $position++) {
                $settingIndex = ($position + $repeat - 1 + $poolIndex) % $settings.Count
                $setting = $settings[$settingIndex]
                $setResult = Invoke-Control -ControlArguments @('set', [string] $setting.rttMs)
                Assert-Proxy -Snapshot $setResult -AddedRttMs $setting.rttMs
                Set-ServerRoute -PoolSize $poolSize -Route $setting.route
                $calibrationKey = "$poolSize/$($setting.route)/$($setting.rttMs)"
                if (-not @($calibrations | Where-Object { $_.key -eq $calibrationKey }).Count) {
                    $calibration = Invoke-Control -ControlArguments @('calibrate', [string] $setting.rttMs, [string] $CalibrationSamples)
                    Assert-Proxy -Snapshot $calibration -AddedRttMs $setting.rttMs
                    Assert-Proxy -Snapshot ([pscustomobject]@{ proxy = $calibration.proxyAfter }) -AddedRttMs $setting.rttMs
                    $calibrationData = $calibration.calibration
                    if ($null -eq $calibrationData -or $calibrationData.connectionReuse -ne $true -or $calibrationData.autoCommit -ne $false -or
                        $calibrationData.readOnly -ne $true -or $calibrationData.isolation -ne 'REPEATABLE_READ' -or $calibrationData.fetchSize -ne 0 -or
                        $calibrationData.warmupRequestsPerConnection -lt 10) { throw 'Calibration did not use the required warm JDBC transaction/query configuration.' }
                    foreach ($side in @('direct', 'proxied')) {
                        $series = $calibrationData.$side
                        if ($series.samples -ne $CalibrationSamples -or @($series.rawSamplesMs).Count -ne $CalibrationSamples -or
                            $null -eq $series.medianMs -or $series.medianMs -lt 0 -or [double]::IsNaN([double] $series.medianMs) -or [double]::IsInfinity([double] $series.medianMs) -or
                            $null -eq $series.p95Ms -or $series.p95Ms -lt 0 -or [double]::IsNaN([double] $series.p95Ms) -or [double]::IsInfinity([double] $series.p95Ms)) {
                            throw "Calibration $side series is incomplete or has invalid timings."
                        }
                    }
                    if ($null -eq $calibrationData.medianDifferenceMs -or [double]::IsNaN([double] $calibrationData.medianDifferenceMs) -or [double]::IsInfinity([double] $calibrationData.medianDifferenceMs)) { throw 'Calibration has no finite direct/proxy median difference.' }
                    $calibrationToleranceMs = [Math]::Max(2.0, $setting.rttMs * 0.25)
                    if ([Math]::Abs($calibrationData.medianDifferenceMs - $setting.rttMs) -gt $calibrationToleranceMs) {
                        $campaign.warnings += "Calibration ${calibrationKey}: direct/proxy median difference $($calibrationData.medianDifferenceMs)ms differs from configured added RTT; proxy overhead and scheduler precision are part of the observed path."
                    }
                    $calibrationFilename = "calibration-$($setting.route)-rtt-$($setting.rttMs)-pool-$poolSize.json"
                    Write-JsonFile -Path (Join-Path $outputPath $calibrationFilename) -Value $calibration
                    $calibrations.Add([pscustomobject]@{ key = $calibrationKey; route = $setting.route; rttMs = $setting.rttMs; poolSize = $poolSize; report = $calibrationFilename })
                    Save-Campaign
                    $correctnessFilename = "correctness-$($setting.route)-rtt-$($setting.rttMs)-pool-$poolSize.json"
                    $correctnessPath = Join-Path $outputPath $correctnessFilename
                    Assert-CampaignNotCancelled -Boundary 'DTO correctness check'
                    & node benchmarks/compare.mjs --base-url $BaseUrl --ids $Ids --warmup 2 --repeats 2 --output $correctnessPath
                    $correctnessExitCode = $LASTEXITCODE
                    $correctness = if (Test-Path -LiteralPath $correctnessPath) { Get-Content -LiteralPath $correctnessPath -Raw | ConvertFrom-Json } else { $null }
                    $correctnessValid = ($null -ne $correctness -and $correctnessExitCode -eq 0 -and $correctness.equalResults -eq $true -and -not $correctness.error -and
                        ($correctness.datasetBefore | ConvertTo-Json -Depth 10 -Compress) -eq $script:baselineJson -and
                        ($correctness.datasetAfter | ConvertTo-Json -Depth 10 -Compress) -eq $script:baselineJson -and @($correctness.samples).Count -eq 4)
                    foreach ($sample in @($correctness.samples)) {
                        $expectedRows = if ($sample.strategy -eq 'v1') { 1000 } else { 260 }
                        $expectedQueries = if ($sample.strategy -eq 'v1') { 1 } else { 3 }
                        if ($sample.postCount -ne 10 -or $sample.metrics.totalRows -ne $expectedRows -or $sample.metrics.queryCount -ne $expectedQueries) { $correctnessValid = $false }
                    }
                    $correctnessChecks.Add([pscustomobject]@{ key = $calibrationKey; route = $setting.route; rttMs = $setting.rttMs; poolSize = $poolSize; report = $correctnessFilename; valid = $correctnessValid })
                    Save-Campaign
                    if (-not $correctnessValid) { throw 'DTO equality, expected row/query counts or dataset consistency check failed before load.' }
                }
                for ($conditionPosition = 0; $conditionPosition -lt $conditions.Count; $conditionPosition++) {
                    $conditionIndex = ($conditionPosition + $repeat - 1) % $conditions.Count
                    $condition = $conditions[$conditionIndex]
                    $order = if (($repeat - 1 + $settingIndex + $poolIndex + $conditionIndex) % 2 -eq 0) { @('v1', 'v2') } else { @('v2', 'v1') }
                    $warmupKey = "$calibrationKey/$($condition.id)/server-generation-$script:serverGeneration"
                    if (-not $warmedConditions.ContainsKey($warmupKey)) {
                        for ($strategyPosition = 0; $strategyPosition -lt 2; $strategyPosition++) {
                            Invoke-StudyPoint -Phase warmup -PoolSize $poolSize -PoolIndex $poolIndex -Setting $setting -Condition $condition -Repeat $repeat -Strategy $order[$strategyPosition] -Order ($strategyPosition + 1) -SettingOrder ($position + 1) -RunDuration $WarmupDuration
                        }
                        $warmedConditions[$warmupKey] = $true
                    }
                    for ($strategyPosition = 0; $strategyPosition -lt 2; $strategyPosition++) {
                        Invoke-StudyPoint -Phase measure -PoolSize $poolSize -PoolIndex $poolIndex -Setting $setting -Condition $condition -Repeat $repeat -Strategy $order[$strategyPosition] -Order ($strategyPosition + 1) -SettingOrder ($position + 1) -RunDuration $Duration
                    }
                }
            }
        }
    }
    $campaign.status = if ($anyLoadFailure) { 'completed_with_load_failures' } else { 'completed' }
} catch {
    $campaign.status = if ($script:cancellationRequested) { 'aborted' } else { 'failed' }
    $campaign.error = $_.Exception.Message
    Write-Warning $campaign.error
} finally {
    $script:cleanupInProgress = $true
    $restoreErrors = [System.Collections.Generic.List[string]]::new()
    if ($proxyTouched) {
        try {
            $resetProxy = Invoke-Control -ControlArguments @('set', '0')
            Assert-Proxy -Snapshot $resetProxy -AddedRttMs 0
        } catch { $restoreErrors.Add("Proxy reset: $($_.Exception.Message)") }
    }
    if ($restoreNeeded) {
        try {
            foreach ($name in $poolVariables) { [Environment]::SetEnvironmentVariable($name, $originalRunningValues[$name], 'Process') }
            $env:LATENCY_DB_URL = $originalDatabaseUrl
            Start-ConfiguredServer
            $actualRestoredUrl = & docker @script:composeArguments exec -T server printenv DB_URL
            if ($LASTEXITCODE -ne 0 -or ([string] $actualRestoredUrl).Trim() -ne $originalDatabaseUrl) { throw 'Original database route was not restored.' }
            $clientId = & docker @script:composeArguments ps --status running -q client
            if ($clientId) {
                & docker @script:composeArguments exec -T client nginx -s reload
                if ($LASTEXITCODE -ne 0) { throw 'Client nginx reload failed after server restoration.' }
            }
            $campaign.datasetAfter = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/lab/dataset') -TimeoutSec 10
            $campaign.datasetUnchanged = (($campaign.datasetAfter | ConvertTo-Json -Depth 10 -Compress) -eq $script:baselineJson)
            if (-not $campaign.datasetUnchanged) { throw 'Dataset differs from baseline after campaign.' }
        } catch { $restoreErrors.Add("Server restoration: $($_.Exception.Message)") }
    }
    $campaign.power.end = Get-CampaignPowerSnapshot
    try { Restore-CampaignSleepPrevention }
    catch { $restoreErrors.Add("Sleep-prevention restoration: $($_.Exception.Message)") }
    if ($restoreErrors.Count -gt 0) {
        $campaign.restoreFailed = $true
        $campaign.restoreError = $restoreErrors -join '; '
        Write-Warning "Could not fully restore initial state: $($campaign.restoreError)"
    }
    foreach ($name in $variableNames) { [Environment]::SetEnvironmentVariable($name, $originalValues[$name], 'Process') }
    $campaign.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Campaign
    Pop-Location
}
Write-Host "Latency reports: $outputPath"
if ($campaign.status -ne 'completed' -or $campaign.restoreFailed) { exit 1 }
