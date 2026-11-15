'use strict';
const os = require('os');
const { runPSJson, runExe } = require('./powershell');

function createCpuSampler() {
  let prev = os.cpus();
  return function sample() {
    const cur = os.cpus();
    let idle = 0, total = 0;
    cur.forEach((c, i) => {
      const p = prev[i];
      if (!p) return;
      for (const k of Object.keys(c.times)) total += c.times[k] - p.times[k];
      idle += c.times.idle - p.times.idle;
    });
    prev = cur;
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  };
}

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem(); // no Windows = memória física disponível
  return {
    totalMB: Math.round(total / 1048576),
    usedMB: Math.round((total - free) / 1048576),
    percent: Math.round((1 - free / total) * 1000) / 10,
  };
}

const STATIC_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name=$_.Name; driver=$_.DriverVersion } })
$cs = Get-CimInstance Win32_ComputerSystem
$enc = Get-CimInstance Win32_SystemEnclosure
$disks = @(Get-PhysicalDisk | ForEach-Object { [ordered]@{ name=$_.FriendlyName; media=[string]$_.MediaType } })
$r = [ordered]@{
  os = $os.Caption; build = $os.BuildNumber; arch = $os.OSArchitecture
  cpu = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  gpus = $gpus; model = $cs.Model; manufacturer = $cs.Manufacturer
  chassis = @($enc.ChassisTypes); physicalDisks = $disks
}
ConvertTo-Json -InputObject $r -Compress -Depth 5`;

const SLOW_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$r.processCount = @(Get-Process).Count
$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [ordered]@{ id=$_.DeviceID; label=$_.VolumeName; totalGB=[math]::Round($_.Size/1GB,1); freeGB=[math]::Round($_.FreeSpace/1GB,1) } })
$g = $null
$c = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue
if ($c) { $g = [math]::Min(100, [math]::Round(($c.CounterSamples | Measure-Object CookedValue -Sum).Sum, 1)) }
$r.gpuUsage = $g
$t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
if ($t) {
  $v = @($t | ForEach-Object { [math]::Round($_.CurrentTemperature/10 - 273.15, 1) })
  $r.acpiTempC = ($v | Measure-Object -Maximum).Maximum
} else { $r.acpiTempC = $null }
ConvertTo-Json -InputObject $r -Compress -Depth 5`;

async function nvidia() {
  const r = await runExe('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 });
  if (!r.ok || !r.stdout) return null;
  const p = r.stdout.split('\n')[0].split(',').map((s) => s.trim());
  const num = (x) => (Number.isFinite(parseFloat(x)) ? parseFloat(x) : null);
  return { name: p[0], tempC: num(p[1]), util: num(p[2]), memUsedMB: num(p[3]), memTotalMB: num(p[4]) };
}

async function staticInfo() {
  const r = await runPSJson(STATIC_SCRIPT, { timeout: 30000 });
  const d = r.data || {};
  const laptopTypes = [8, 9, 10, 11, 14, 30, 31, 32];
  return { ...d, isLaptop: (d.chassis || []).some((c) => laptopTypes.includes(c)), totalRamMB: memInfo().totalMB, error: r.ok ? null : r.stderr };
}

// Valores ausentes ficam null: a interface mostra "indisponível", nunca um número inventado.
async function slowMetrics() {
  const [r, nv] = await Promise.all([runPSJson(SLOW_SCRIPT, { timeout: 25000 }), nvidia()]);
  const d = r.data || {};
  return {
    processCount: d.processCount ?? null,
    disks: d.disks || [],
    gpuUsage: nv && nv.util != null ? nv.util : d.gpuUsage ?? null,
    gpuSource: nv ? 'nvidia-smi' : d.gpuUsage != null ? 'contador "GPU Engine" do Windows' : null,
    gpuTempC: nv ? nv.tempC : null,
    gpuName: nv ? nv.name : null,
    cpuTempC: d.acpiTempC ?? null,
    cpuTempSource: d.acpiTempC != null ? 'zona térmica ACPI' : null,
  };
}

module.exports = { createCpuSampler, memInfo, staticInfo, slowMetrics, nvidia };
