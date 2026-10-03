const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs/promises');

const execFileAsync = promisify(execFile);

async function protectData(data) {
  const scriptContent = `
    Add-Type -AssemblyName System.Security
    $bytes = [Text.Encoding]::UTF8.GetBytes('${data.replace(/'/g, "''")}')
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($encrypted)
  `;
  const tmpFile = path.join(process.cwd(), '.mcp-protect.ps1');
  await fs.writeFile(tmpFile, scriptContent, 'utf8');
  
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
    return stdout.trim();
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function unprotectData(base64Data) {
  const scriptContent = `
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String('${base64Data}')
    $decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Text.Encoding]::UTF8.GetString($decrypted)
  `;
  const tmpFile = path.join(process.cwd(), '.mcp-unprotect.ps1');
  await fs.writeFile(tmpFile, scriptContent, 'utf8');
  
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
    return stdout.trim();
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function run() {
  const msg = "my secret key 123";
  console.log("Original:", msg);
  const encrypted = await protectData(msg);
  console.log("Encrypted:", encrypted);
  const decrypted = await unprotectData(encrypted);
  console.log("Decrypted:", decrypted);
}
run();
