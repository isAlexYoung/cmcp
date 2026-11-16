import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Compiled from the shipped source into private state; no download or elevation.
export function commandGuard(stateDir) {
  const source = fileURLToPath(new URL('./windows-command-guard.cs', import.meta.url));
  const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 20);
  const folder = path.join(stateDir, 'command-guard');
  fs.mkdirSync(folder, { recursive: true });
  const executable = path.join(folder, `guard-${digest}.exe`);
  if (!fs.existsSync(executable)) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const temporary = executable + `.${process.pid}.tmp.exe`;
    try {
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${temporary}`, source], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
      try { fs.renameSync(temporary, executable); } catch (error) { if (!fs.existsSync(executable)) throw error; }
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  return executable;
}

export function guardedCommand(stateDir, executable, args, cwd, verbatim, memoryMb = 2048) {
  // FILETIME ticks let the helper reject PID reuse without WMI. Read the owner's start time once via its PID.
  const request = { executable, args, cwd, verbatim, memoryMb, owner: process.pid,
    ownerStart: ownerStartTicks() };
  return { executable: commandGuard(stateDir), args: [Buffer.from(JSON.stringify(request)).toString('base64')] };
}

let started;
function ownerStartTicks() {
  if (started) return started;
  // Node's uptime is not an exact creation timestamp. Query .NET Process directly, never CIM.
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  started = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Write([Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks)`], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).trim();
  if (!/^\d{17,19}$/.test(started)) throw new Error('Cannot identify the command owner');
  return started;
}
