import { execFile } from 'node:child_process';
import { appendFile, access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const directory = resolve(process.argv[2] ?? 'benchmarks/results/repeated-study');
const baseUrl = (process.argv[3] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const output = resolve(directory, 'resources.jsonl');
const stopFile = resolve(directory, 'monitor-stop');
await mkdir(directory, { recursive: true });

function numericSample(text, name, sum = false) {
  const values = text.split(/\r?\n/).filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`))
    .map((line) => Number(line.trim().split(/\s+/).at(-1))).filter(Number.isFinite);
  return values.length ? (sum ? values.reduce((total, value) => total + value, 0) : values[0]) : null;
}

async function docker(...args) {
  const result = await execute('docker', args, { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

while (true) {
  try { await access(stopFile); break; } catch { /* Continue until the campaign asks us to stop. */ }
  const started = Date.now();
  const record = { at: new Date().toISOString(), resources: [], jvm: null, errors: [] };
  await Promise.all([
    (async () => {
      try {
        const names = (await docker('ps', '--filter', 'label=com.docker.compose.project=spring-query-lab', '--format', '{{.Names}}'))
          .split(/\r?\n/).filter((name) => /server|db|querylab-load-/.test(name));
        const stable = names.filter((name) => !name.startsWith('querylab-load-'));
        const generators = names.filter((name) => name.startsWith('querylab-load-'));
        await Promise.all([stable, generators].filter((group) => group.length).map(async (group) => {
          try {
            const stats = await docker('stats', '--no-stream', '--format', '{{json .}}', ...group);
            const samples = stats.trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const stat = JSON.parse(line);
            return { name: stat.Name, id: stat.ID, cpuPercent: Number.parseFloat(stat.CPUPerc), memory: stat.MemUsage,
              memoryPercent: Number.parseFloat(stat.MemPerc), pids: Number(stat.PIDs) };
            });
            record.resources.push(...samples);
          } catch (error) { record.errors.push(`docker ${group.join(',')}: ${error.message}`); }
        }));
      } catch (error) { record.errors.push(`docker: ${error.message}`); }
    })(),
    (async () => {
      try {
        const response = await fetch(`${baseUrl}/actuator/prometheus`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        record.jvm = {
          uptimeSeconds: numericSample(text, 'process_uptime_seconds'),
          processCpuUsage: numericSample(text, 'process_cpu_usage'),
          systemCpuUsage: numericSample(text, 'system_cpu_usage'),
          gcPauseSeconds: numericSample(text, 'jvm_gc_pause_seconds_sum', true),
          gcPauseCount: numericSample(text, 'jvm_gc_pause_seconds_count', true),
          allocatedBytes: numericSample(text, 'jvm_gc_memory_allocated_bytes_total', true),
          info: text.split(/\r?\n/).find((line) => line.startsWith('jvm_info{')) ?? null,
        };
      } catch (error) { record.errors.push(`jvm: ${error.message}`); }
    })(),
  ]);
  await appendFile(output, `${JSON.stringify(record)}\n`, 'utf8');
  await delay(Math.max(0, 5000 - (Date.now() - started)));
}
console.log(`Resource samples saved: ${output}`);
