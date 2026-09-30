#!/usr/bin/env node
/**
 * tools/setup.mjs: the interactive part of the installer (install.bat / install.sh call it).
 *
 * It asks a few questions, then downloads and wires up everything the studio needs:
 *   1. a local AI "brain" for LM Studio, sized to the graphics card (VRAM) it detects;
 *   2. optionally ComfyUI (local image generation + editing) with Qwen-Image 2.1 at Q8 or Q4;
 *   3. optionally the video workflow (FastH3), after warning that it needs 16-24 GB of VRAM;
 *   4. the app's settings, so the first start already points at the right models and workflows.
 *
 * Design rules:
 *   - Every download is resumable (HTTP Range) and checked against the published size and
 *     SHA-256 before it is moved into place, so a dropped connection never leaves a broken model.
 *   - Files that are already present with the right size are kept, not downloaded again.
 *   - Nothing outside this folder, the LM Studio models folder and the app's own settings is touched.
 *   - No third-party npm packages: only Node's standard library.
 *
 * Flags (mainly for testing): --dry-run (plan only, download nothing), --yes (accept the
 * recommended answer to every question), --vram <GB> (pretend this much VRAM), --comfy-dir <path>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DRY = flag('--dry-run');
const YES = flag('--yes');
const IS_WIN = process.platform === 'win32';
const HF = 'https://huggingface.co/';
const GB = 1e9;

// ------------------------------------------------------------------ catalogue
/**
 * Language models for LM Studio, smallest first. `vram` is what the model needs to run fully
 * on the graphics card at the default 64k context; below that LM Studio still runs it, but
 * moves part of it to the CPU, which is slower. Sizes and SHA-256 come from Hugging Face.
 */
const LLMS = [
  { id: 'e4b', label: 'Fast-lightweight', name: 'Gemma 4 E4B', vram: 0,
    note: 'no graphics card / under 6 GB', repo: 'unsloth/gemma-4-E4B-it-GGUF',
    files: [['gemma-4-E4B-it-Q4_K_M.gguf', 4977171584, '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87'],
      ['mmproj-F16.gguf', 990372672, 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51']] },
  { id: '9b', label: 'Balanced', name: 'Qwen3.5 9B', vram: 8,
    note: '8 GB cards', repo: 'unsloth/Qwen3.5-9B-GGUF',
    files: [['Qwen3.5-9B-Q4_K_M.gguf', 5680522464, '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'],
      ['mmproj-F16.gguf', 918166080, 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f']] },
  { id: '12b', label: 'Quality', name: 'Gemma 4 12B', vram: 12,
    note: '12 GB cards', repo: 'unsloth/gemma-4-12b-it-GGUF',
    files: [['gemma-4-12b-it-Q4_K_M.gguf', 7121861440, '0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42'],
      ['mmproj-F16.gguf', 175115840, '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e']] },
  { id: '27b-3', label: 'High Quality (compact)', name: 'Qwen3.8 27B, 3-bit', vram: 16,
    note: '16 GB cards', repo: 'unsloth/Qwen3.8-27B-GGUF', kvQ8: true,
    files: [['Qwen3.8-27B-UD-IQ3_S.gguf', 12040883104, 'd847e2c1e4aa276e4b7b8e9ad7628050e61e165d49ab995407bc36677a6f3864'],
      ['mmproj-F16.gguf', 927607488, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e']] },
  { id: '27b', label: 'High Quality', name: 'Qwen3.8 27B, Q4_K_XL', vram: 24,
    note: '24 GB cards', repo: 'unsloth/Qwen3.8-27B-GGUF', kvQ8: true,
    files: [['Qwen3.8-27B-UD-Q4_K_XL.gguf', 17559178144, '3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e'],
      ['mmproj-F16.gguf', 927607488, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e']] },
];
const CONTEXT = 65536; // 64k tokens: plenty for every job in the app; change it in LM Studio if needed.

/** ComfyUI model files: [subfolder, file name, url, size, sha256]. */
const QWEN_TE = ['text_encoders', 'qwen3vl_8b_int8_convrot.safetensors',
  HF + 'Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors',
  9350798360, '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f'];
const QWEN_VAE = ['vae', 'qwen_image_2.1_vae_bf16.safetensors',
  HF + 'Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
  675509688, 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9'];
const IMAGE = {
  Q8: { label: 'Quality', vram: 8, workflow: 'AiLabor_Qwen-Image-2.1_Q8.json', files: [
    ['diffusion_models', 'qwen_image_2.1_Q8_0.gguf', HF + 'AlperKTS/Qwen-Image-2.1-GGUF/resolve/main/qwen_image_2.1_Q8_0.gguf',
      7624265888, '5f006f64227315a45f3c7f1a134306cb2b86dcdc3372e176f019bd329740c36d'], QWEN_TE, QWEN_VAE] },
  Q4: { label: 'Balanced', vram: 5, workflow: 'AiLabor_Qwen-Image-2.1_Q4.json', files: [
    ['diffusion_models', 'qwen_image_2.1_Q4_K_M.gguf', HF + 'Abiray/Qwen-Image-2.1-GGUF/resolve/main/qwen_image_2.1_Q4_K_M.gguf',
      4189343904, 'dc956c958fbfa1d5c64ec316d7e865283d17d97a9eb332a4a74a4d63afaae9a5'], QWEN_TE, QWEN_VAE] },
};
const VIDEO = { workflow: 'AiLabor_FastH3_Video.json', files: [
  ['diffusion_models', 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
    HF + 'Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
    22898594920, '7221ae65d78780354d51e5048d29728d9f1f8fb9baf50b1dd3df85f5101413d3'],
  ['text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    HF + 'Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    15687142551, '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6'],
  ['vae', 'minimax_h3_video_vae_fp16.safetensors', HF + 'Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors',
    5207808496, '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522'],
  ['vae', 'minimax_h3_audio_vae_fp32.safetensors', HF + 'Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors',
    605254808, '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48'],
] };
/** The GGUF loader node for ComfyUI, pinned to a tested commit. */
const GGUF_NODE = { sha: '6ea2651e7df66d7585f6ffee804b20e92fb38b8a', repo: 'city96/ComfyUI-GGUF' };
/** Used only if GitHub's release API cannot be reached. v0.37.0 is the first stable with Qwen-Image 2.1. */
const COMFY_FALLBACK = { tag: 'v0.37.0', url: 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.37.0/ComfyUI_windows_portable_nvidia.7z',
  size: 1925204508, sha256: '7805f634fab51f63a238aaf0cfe2a9833bb7c86ddfc8400a60919f44460d7d65' };

// ------------------------------------------------------------------ small helpers
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const say = (s = '') => console.log(s);
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
const sumSize = (files) => files.reduce((a, f) => a + f[f.length - 2], 0);

/** Ask a yes/no question; Enter picks the default. */
async function yesNo(question, dflt) {
  if (YES) { say(`${question} ${dflt ? 'yes' : 'no'} (--yes)`); return dflt; }
  const a = (await rl.question(`${question} [${dflt ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
  return a ? a.startsWith('y') : dflt;
}

/** Numbered menu; returns the chosen index, or -1 for "skip" when allowed. */
async function menu(title, rows, recommended, allowSkip) {
  say(`\n${title}`);
  rows.forEach((r, i) => say(`  ${i + 1}) ${r}${i === recommended ? '   <- recommended' : ''}`));
  if (allowSkip) say('  0) skip');
  if (YES) { say(`Choice: ${recommended + 1} (--yes)`); return recommended; }
  for (;;) {
    const a = (await rl.question(`Choice [${recommended + 1}]: `)).trim();
    if (!a) return recommended;
    const n = Number(a);
    if (allowSkip && n === 0) return -1;
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) return n - 1;
    say('Please type one of the numbers above.');
  }
}

// ------------------------------------------------------------------ hardware
/**
 * Detect the graphics card and its memory. NVIDIA reports exactly through nvidia-smi; for other
 * cards Windows keeps a 64-bit memory size in the display-adapter registry keys (the WMI
 * AdapterRAM field is 32-bit and tops out at 4 GB, so it is not used).
 */
function detectGpu() {
  if (opt('--vram')) return { vendor: 'nvidia', name: 'forced by --vram', vramGB: Number(opt('--vram')) };
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    const best = out.trim().split(/\r?\n/).map((l) => l.split(',').map((s) => s.trim()))
      .map(([name, mib]) => ({ vendor: 'nvidia', name, vramGB: Number(mib) / 1024 }))
      .sort((a, b) => b.vramGB - a.vramGB)[0];
    if (best && best.vramGB > 0) return best;
  } catch { /* no NVIDIA driver */ }
  if (IS_WIN) {
    try {
      const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
      const out = execFileSync('reg', ['query', key, '/s', '/v', 'HardwareInformation.qwMemorySize'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      const sizes = [...out.matchAll(/qwMemorySize\s+REG_QWORD\s+0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16) / 2 ** 30);
      const desc = execFileSync('reg', ['query', key, '/s', '/v', 'DriverDesc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const names = [...desc.matchAll(/DriverDesc\s+REG_SZ\s+(.+)/g)].map((m) => m[1].trim());
      const name = names.find((n) => /radeon|amd|arc|intel/i.test(n)) || names[0] || 'unknown';
      const vramGB = sizes.length ? Math.max(...sizes) : 0;
      const vendor = /radeon|amd/i.test(name) ? 'amd' : /intel|arc/i.test(name) ? 'intel' : 'other';
      // Integrated graphics share system RAM; treat anything under 2 GB as "no graphics card".
      if (vramGB >= 2) return { vendor, name, vramGB };
    } catch { /* fall through */ }
  }
  return { vendor: 'none', name: 'none found', vramGB: 0 };
}

/** Index into LLMS of the best model that fits the detected VRAM. */
function recommendLlm(vramGB) {
  const v = Math.round(vramGB); // a "12 GB" card reports 11.9 or 12.0 depending on the driver
  let pick = 0;
  LLMS.forEach((m, i) => { if (m.vram <= v) pick = i; });
  return pick;
}

// ------------------------------------------------------------------ downloads
/**
 * Download `url` to `dest`, resuming a previous partial file, then check size + SHA-256.
 * The data goes to `dest + '.part'` and is only renamed when it verifies.
 */
async function download(url, dest, size, sha256) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) { say(`  ok (already here)  ${path.basename(dest)}`); return; }
  if (DRY) { say(`  would download ${gb(size)}  ${path.basename(dest)}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  for (let attempt = 1; ; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > size) { fs.rmSync(part); have = 0; }
    try {
      if (have < size) await fetchRange(url, part, have, size);
      process.stdout.write(`  checking ${path.basename(dest)} ...`);
      const got = sha256 ? await hashFile(part) : null;
      if (sha256 && got !== sha256) {
        fs.rmSync(part);
        throw new Error(`checksum mismatch (got ${got.slice(0, 12)}...), the file was deleted and will be fetched again`);
      }
      fs.renameSync(part, dest);
      say(' verified');
      return;
    } catch (e) {
      say(`\n  problem: ${e.message}`);
      if (attempt >= 5) throw new Error(`giving up on ${path.basename(dest)} after 5 attempts; run the installer again to resume`);
      say(`  retrying in ${attempt * 5} s (attempt ${attempt + 1} of 5) ...`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

/** Stream bytes [from, size) of `url` onto the end of `file`, printing progress. */
async function fetchRange(url, file, from, size) {
  const res = await fetch(url, { headers: from ? { Range: `bytes=${from}-` } : {}, redirect: 'follow' });
  if (from && res.status !== 206) throw new Error(`server refused to resume (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const out = fs.createWriteStream(file, { flags: from ? 'a' : 'w' });
  let done = from; let last = 0; const t0 = Date.now(); const start = from;
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      done += chunk.length;
      if (Date.now() - last > 1000) {
        last = Date.now();
        const mbs = (done - start) / 1e6 / Math.max(1, (Date.now() - t0) / 1000);
        const eta = mbs > 0 ? Math.round((size - done) / 1e6 / mbs / 60) : '?';
        process.stdout.write(`\r  ${path.basename(file, '.part')}: ${(100 * done / size).toFixed(1)}% of ${gb(size)}, ${mbs.toFixed(1)} MB/s, ~${eta} min left   `);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  process.stdout.write('\n');
  if (fs.statSync(file).size !== size) throw new Error('connection closed early');
}

/** SHA-256 of a file, streamed so multi-GB files do not need to fit in memory. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 8 << 20 }).on('data', (d) => h.update(d)).on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Free space on the drive that holds `dir`, in bytes (null if unknown). */
function freeBytes(dir) {
  try {
    let d = path.resolve(dir);
    while (!fs.existsSync(d)) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return s.bavail * s.bsize;
  } catch { return null; }
}

// ------------------------------------------------------------------ LM Studio
const LMS_HOME = path.join(os.homedir(), '.lmstudio');
const LMS_CLI = path.join(LMS_HOME, 'bin', IS_WIN ? 'lms.exe' : 'lms');

/** LM Studio's model folder (it can be moved in LM Studio's settings; default ~/.lmstudio/models). */
function lmStudioModelsDir() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(LMS_HOME, 'settings.json'), 'utf8'));
    if (s.downloadsFolder) return s.downloadsFolder;
  } catch { /* not configured yet */ }
  return path.join(LMS_HOME, 'models');
}

function lmStudioInstalled() {
  if (fs.existsSync(LMS_CLI)) return true;
  if (IS_WIN) return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'));
  return fs.existsSync('/Applications/LM Studio.app');
}

/**
 * Make LM Studio load this model with a 64k context by default. This is the same per-model
 * "remember these settings" file LM Studio's own model settings panel writes; an existing file
 * is left alone so a user's own choice always wins.
 */
function writeLmDefaults(m) {
  const file = path.join(LMS_HOME, '.internal', 'user-concrete-model-default-config', m.repo, `${m.files[0][0]}.json`);
  if (fs.existsSync(file)) { say(`  kept your existing LM Studio settings for ${m.name}`); return; }
  const fields = [{ key: 'llm.load.contextLength', value: CONTEXT }];
  if (m.kvQ8) { // 8-bit KV cache: halves the memory the 64k context needs, with negligible quality cost
    fields.push({ key: 'llm.load.llama.kCacheQuantizationType', value: { checked: true, value: 'q8_0' } });
    fields.push({ key: 'llm.load.llama.vCacheQuantizationType', value: { checked: true, value: 'q8_0' } });
  }
  if (DRY) { say(`  would set ${m.name} to a ${CONTEXT / 1024}k context in LM Studio`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ preset: '', operation: { fields: [] }, load: { fields } }, null, 2));
  say(`  LM Studio will load ${m.name} with a ${CONTEXT / 1024}k context`);
}

/**
 * The name the app must send to LM Studio for this model. LM Studio derives it from the folder;
 * ask its CLI when available, otherwise use the same rule it applies (repo name minus "-GGUF").
 */
function lmModelKey(m) {
  const rel = `${m.repo}/${m.files[0][0]}`.toLowerCase();
  if (fs.existsSync(LMS_CLI)) {
    try {
      const list = JSON.parse(execFileSync(LMS_CLI, ['ls', '--json'], { encoding: 'utf8', timeout: 60000 }));
      const hit = list.find((e) => String(e.path || '').replace(/\\/g, '/').toLowerCase() === rel);
      if (hit) return hit.modelKey;
    } catch { /* fall back */ }
  }
  return m.repo.split('/')[1].replace(/-GGUF$/i, '').toLowerCase();
}

// ------------------------------------------------------------------ ComfyUI
/** Latest stable portable build for this vendor from GitHub, or the pinned fallback. */
async function comfyRelease(vendor) {
  const asset = vendor === 'amd' ? 'ComfyUI_windows_portable_amd.7z'
    : vendor === 'intel' ? 'ComfyUI_windows_portable_intel.7z' : 'ComfyUI_windows_portable_nvidia.7z';
  try {
    const r = await fetch('https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest', { headers: { 'User-Agent': 'ailabor-setup' } });
    const j = await r.json();
    const a = (j.assets || []).find((x) => x.name === asset);
    if (a && a.digest && a.digest.startsWith('sha256:')) {
      return { tag: j.tag_name, url: a.browser_download_url, size: a.size, sha256: a.digest.slice(7) };
    }
  } catch { /* offline or rate-limited */ }
  return { ...COMFY_FALLBACK, url: COMFY_FALLBACK.url.replace('ComfyUI_windows_portable_nvidia.7z', asset),
    sha256: asset.includes('nvidia') ? COMFY_FALLBACK.sha256 : null };
}

/** Run a program, streaming its output; throws when it fails. */
function run(cmd, cmdArgs, cwd) {
  if (DRY) { say(`  would run: ${cmd} ${cmdArgs.join(' ')}`); return; }
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed (exit ${r.status})`);
}

/**
 * Install portable ComfyUI into `dir`, update it to the newest stable release, add the GGUF
 * loader node, copy the studio's workflows into ComfyUI's own workflow folder, download models.
 */
async function installComfy(dir, gpu, imageChoice, withVideo) {
  const base = path.join(dir, 'ComfyUI_windows_portable');
  const py = path.join(base, 'python_embeded', 'python.exe');
  const comfy = path.join(base, 'ComfyUI');
  if (!fs.existsSync(path.join(comfy, 'main.py'))) {
    const rel = await comfyRelease(gpu.vendor);
    say(`\nComfyUI ${rel.tag} (portable, ${gb(rel.size)} download)`);
    const archive = path.join(dir, path.basename(rel.url));
    if (rel.sha256) await download(rel.url, archive, rel.size, rel.sha256);
    else { say('  (no published checksum for this build; size is still checked)'); await download(rel.url, archive, rel.size, null); }
    say('  unpacking (Windows\' built-in tar reads .7z) ...');
    run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dir]);
    if (!DRY) fs.rmSync(archive, { force: true });
  } else say(`\nComfyUI already installed in ${base}`);

  say('  updating ComfyUI to the newest stable release ...');
  run(py, [path.join(base, 'update', 'update.py'), comfy + path.sep, '--stable'], path.join(base, 'update'));
  const newUpdater = path.join(base, 'update', 'update_new.py');
  if (!DRY && fs.existsSync(newUpdater)) { // the updater replaced itself: run the new one once more
    fs.renameSync(newUpdater, path.join(base, 'update', 'update.py'));
    run(py, [path.join(base, 'update', 'update.py'), comfy + path.sep, '--skip_self_update', '--stable'], path.join(base, 'update'));
  }

  const nodeDir = path.join(comfy, 'custom_nodes', 'ComfyUI-GGUF');
  if (!fs.existsSync(path.join(nodeDir, 'nodes.py'))) {
    say('  adding the ComfyUI-GGUF loader node ...');
    if (!DRY) {
      const zip = path.join(dir, 'comfyui-gguf.zip');
      const r = await fetch(`https://github.com/${GGUF_NODE.repo}/archive/${GGUF_NODE.sha}.zip`);
      if (!r.ok) throw new Error(`could not download ComfyUI-GGUF (HTTP ${r.status})`);
      fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
      run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', path.join(comfy, 'custom_nodes')]);
      fs.renameSync(path.join(comfy, 'custom_nodes', `ComfyUI-GGUF-${GGUF_NODE.sha}`), nodeDir);
      fs.rmSync(zip, { force: true });
    }
  }
  run(py, ['-s', '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', path.join(nodeDir, 'requirements.txt')], base);

  // The app reads its workflows from the same folder ComfyUI lists in its sidebar.
  const wfDir = path.join(comfy, 'user', 'default', 'workflows');
  const wanted = [IMAGE[imageChoice].workflow, ...(withVideo ? [VIDEO.workflow] : [])];
  if (!DRY) {
    fs.mkdirSync(wfDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'workflows'))) fs.copyFileSync(path.join(ROOT, 'workflows', f), path.join(wfDir, f));
    fs.mkdirSync(path.join(comfy, 'input'), { recursive: true }); // placeholder frame for the video workflow's Load Image node
    fs.copyFileSync(path.join(ROOT, 'src', 'assets', 'icon.png'), path.join(comfy, 'input', 'example.png'));
  }
  say(`  workflows installed: ${wanted.join(', ')}`);

  const files = [...IMAGE[imageChoice].files, ...(withVideo ? VIDEO.files : [])];
  say(`\nDownloading ComfyUI models (${gb(sumSize(files))} in total) ...`);
  for (const [sub, name, url, size, sha] of files) await download(url, path.join(comfy, 'models', sub, name), size, sha);

  // A launcher for people, and a launch command the app uses to start ComfyUI when it is not running.
  const extra = gpu.vendor === 'none' ? ' --cpu' : '';
  const launch = `"${py}" -s "${path.join(comfy, 'main.py')}" --windows-standalone-build --disable-auto-launch --port 8188${extra}`;
  if (!DRY) fs.writeFileSync(path.join(ROOT, 'start_comfyui.bat'), `@echo off\r\ncd /d "${base}"\r\n${launch}\r\npause\r\n`);
  return { wfDir, launch, imageWorkflow: IMAGE[imageChoice].workflow, videoWorkflow: withVideo ? VIDEO.workflow : '' };
}

// ------------------------------------------------------------------ app settings
/**
 * Merge the choices into the app's settings.json (Electron keeps it in the per-user app-data
 * folder named after productName). Only the keys set here change; everything else is kept.
 */
function writeAppSettings(patch) {
  const appData = IS_WIN ? process.env.APPDATA
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const name = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).productName;
  const file = path.join(appData, name, 'settings.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    return a;
  };
  if (DRY) { say(`\nwould update ${file} with:\n${JSON.stringify(patch, null, 2)}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merge(cur, patch), null, 2));
  say(`\nSaved the studio's settings: ${file}`);
}

// ------------------------------------------------------------------ main flow
async function main() {
  say('\nAiLabor Art Studio setup' + (DRY ? ' (dry run: nothing is downloaded or changed)' : ''));
  say('========================');
  const gpu = detectGpu();
  say(gpu.vramGB ? `Graphics card: ${gpu.name}, ${gpu.vramGB.toFixed(1)} GB of VRAM`
    : 'No dedicated graphics card found: the AI will run on the processor (slower, but it works).');

  // 1. Language model for LM Studio.
  const rec = recommendLlm(gpu.vramGB);
  const rows = LLMS.map((m) => `${m.label.padEnd(24)} ${m.name.padEnd(22)} ${gb(sumSize(m.files)).padStart(8)}  (${m.note})`);
  const pick = await menu('Which AI model should write prompts, titles and check the pictures?', rows, rec, true);
  const llm = pick >= 0 ? LLMS[pick] : null;
  if (llm && llm.vram > Math.round(gpu.vramGB)) say(`  Note: ${llm.name} is meant for ${llm.note}; on this card part of it runs on the processor, which is slower.`);

  // 2. ComfyUI (Windows portable build).
  let comfyWanted = false; let imageChoice = 'Q8'; let withVideo = false;
  if (IS_WIN) {
    say('\nImages: the free online generator (Perchance) works with no setup. ComfyUI makes pictures on your own');
    say('graphics card instead, and adds picture editing. It needs about 20 GB of disk space.');
    comfyWanted = await yesNo('Install ComfyUI?', gpu.vendor !== 'none' && gpu.vramGB >= 6);
    if (comfyWanted && gpu.vendor === 'none') say('  Warning: without a graphics card ComfyUI renders on the processor and takes many minutes per picture.');
    if (comfyWanted) {
      const q = await menu('Image model, Qwen-Image 2.1:', [
        `Q8  ${IMAGE.Q8.label.padEnd(9)} (about 8 GB of VRAM)    ${gb(sumSize(IMAGE.Q8.files))}`,
        `Q4  ${IMAGE.Q4.label.padEnd(9)} (about 4-5 GB of VRAM)  ${gb(sumSize(IMAGE.Q4.files))}`,
      ], gpu.vramGB >= 8 ? 0 : 1, false);
      imageChoice = q === 0 ? 'Q8' : 'Q4';
      say('\nVideo turns approved pictures into short clips with sound (FastH3).');
      say(`  WARNING: it needs a graphics card with 16-24 GB of VRAM and a ${gb(sumSize(VIDEO.files))} download.`);
      withVideo = await yesNo('Install video generation?', false);
      if (withVideo && gpu.vramGB < 15.5) say('  Your card has less than 16 GB of VRAM: expect video jobs to fail or be very slow.');
    }
  } else {
    say('\nComfyUI: this installer sets it up on Windows only. On macOS/Linux install ComfyUI yourself');
    say('(https://github.com/Comfy-Org/ComfyUI), add the ComfyUI-GGUF node and copy the files in workflows/.');
  }

  // Disk space check before any download starts.
  const need = (llm ? sumSize(llm.files) : 0)
    + (comfyWanted ? sumSize(IMAGE[imageChoice].files) + 8 * GB + (withVideo ? sumSize(VIDEO.files) : 0) : 0);
  const comfyDir = path.resolve(opt('--comfy-dir', path.join(ROOT, 'comfyui')));
  const free = freeBytes(comfyWanted ? comfyDir : lmStudioModelsDir());
  say(`\nTotal download and install size: about ${gb(need)}` + (free ? `; free on that drive: ${gb(free)}` : ''));
  if (free && free < need * 1.05 && !(await yesNo('That may not fit. Continue anyway?', false))) return;

  const settings = { gen: { engine: comfyWanted ? 'comfy' : 'perchance' } };

  // 3. LM Studio + the chosen language model.
  if (llm) {
    if (!lmStudioInstalled()) {
      say('\nLM Studio (the free app that runs the AI model on this PC) is not installed.');
      if (IS_WIN && await yesNo('Install LM Studio now with winget?', true)) {
        run('winget', ['install', '-e', '--id', 'ElementLabs.LMStudio', '--accept-package-agreements', '--accept-source-agreements']);
      } else say('  Get it from https://lmstudio.ai, then run this installer again or load the model yourself.');
    }
    const dir = path.join(lmStudioModelsDir(), ...llm.repo.split('/'));
    say(`\nDownloading ${llm.name} for LM Studio into ${dir}`);
    for (const [name, size, sha] of llm.files) await download(`${HF}${llm.repo}/resolve/main/${name}`, path.join(dir, name), size, sha);
    writeLmDefaults(llm);
    const key = lmModelKey(llm);
    settings.lmStudio = { model: key };
    say(`  the studio will ask LM Studio for "${key}"`);
    if (fs.existsSync(LMS_CLI) && !DRY) {
      try { execFileSync(LMS_CLI, ['server', 'start'], { stdio: 'ignore', timeout: 60000 }); say('  LM Studio\'s local server is running.'); } catch { /* started later from the app */ }
    }
  }

  // 4. ComfyUI, workflows and models.
  if (comfyWanted) {
    const c = await installComfy(comfyDir, gpu, imageChoice, withVideo);
    settings.comfy = { serverUrl: 'http://127.0.0.1:8188', workflowsDir: c.wfDir, imageWorkflow: c.imageWorkflow,
      videoWorkflow: c.videoWorkflow, launchCommand: c.launch };
  }

  writeAppSettings(settings);
  say('\nAll done.');
  if (llm) say(' - Open LM Studio once and make sure its local server is on (Developer tab), if the app says it cannot reach it.');
  if (comfyWanted) say(' - The app starts ComfyUI by itself when it needs it; start_comfyui.bat opens it by hand.');
  say(' - Start the studio with start.bat.');
}

main().catch((e) => { say(`\nSetup stopped: ${e.message}\nRun the installer again: finished downloads are kept and unfinished ones resume.`); process.exitCode = 1; })
  .finally(() => rl.close());
