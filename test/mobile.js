/**
 * Run test/mobile.html in a real headless Chrome and report the checks.
 *
 * The harness page does the measuring inside an iframe of each size; this runner only creates
 * a scratch project for it to open and reads the JSON back out of the page. No dependencies:
 * Chrome's own --dump-dom is the transport.
 *
 *     node test/mobile.js            (KEEP=1 to keep the scratch project)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = process.env.LINES_URL || process.env.SERVICE_URL || 'http://127.0.0.1:8793';
const STATIC = process.env.STATIC_URL || 'http://127.0.0.1:8791';
const ELA = process.env.ELA_PDF || path.join(os.homedir(), 'ela-menu', 'ela-a4-final-A.pdf');
const CHROME = process.env.CHROME_BIN || 'google-chrome';

async function post(p, body) {
  const res = await fetch(SERVICE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable',
                      'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch (e) { /* next */ }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(ELA)) {
    console.error('no source PDF at', ELA, '- set ELA_PDF');
    process.exit(2);
  }
  const health = await fetch(SERVICE + '/health').then(r => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error('the sidecar is not answering at', SERVICE, '- start it: .lines/bin/python sidecar/lines_server.py');
    process.exit(2);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('no Chrome/Chromium found - set CHROME_BIN');
    process.exit(2);
  }

  const pdf = fs.readFileSync(ELA).toString('base64');
  const made = await post('/projects', { name: 'Mobile Harness', pdf });
  if (made.status !== 200) {
    console.error('could not create the scratch project', made);
    process.exit(1);
  }
  const slug = made.json.meta.slug;
  console.log('scratch project:', slug);

  const url = STATIC + '/test/mobile.html?slug=' + encodeURIComponent(slug);
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
                '--window-size=390,900', '--force-device-scale-factor=3',
                // the dump happens when the budget runs out, so this is headroom, not a timeout:
                // five sizes, a rename round trip and a real import all run inside it
                '--virtual-time-budget=150000', '--dump-dom', url];
  let dom = '';
  try {
    dom = execFileSync(chrome, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  } catch (e) {
    if (e.stdout) dom = String(e.stdout);
    else { console.error('chrome failed:', e.message); process.exit(1); }
  }

  const m = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error('no report in the page — the harness did not finish');
    console.error(dom.slice(0, 600));
    process.exit(1);
  }
  const report = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

  let failed = 0, passed = 0;
  for (const c of report.checks) {
    if (c.ok) passed++;
    else {
      failed++;
      console.log('  FAIL [' + c.size + '] ' + c.name + (c.detail ? ' — ' + c.detail : ''));
    }
  }
  console.log('timing:', JSON.stringify(report.timing));

  if (!process.env.KEEP) {
    fs.rmSync(path.join(ROOT, 'projects', slug), { recursive: true, force: true });
    console.log('(removed the scratch project — KEEP=1 to inspect it)');
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' — ' + passed + '/' + (passed + failed) + ' checks' +
              ' across ' + report.sizes.join(', '));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
