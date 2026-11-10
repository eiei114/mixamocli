#!/usr/bin/env node
// mixamo — Mixamo (Adobe) のアニメーションを CLI で検索・書き出しする。
//
//   前提: ログイン済みの Chrome が CDP で開いている（既定 127.0.0.1:9223、MIXAMO_CDP で変更）。
//   アクセストークンはその Chrome の Mixamo タブの localStorage.access_token から取る。
//
//   mixamo login                              常駐 Chrome に Mixamo のログイン画面を開く
//   mixamo token [--save]                     CDP からトークンを取り直す（--save で保存）
//   mixamo token --set <jwt>                  手渡されたトークンを保存
//   mixamo status                             トークン/CDP/プライマリキャラの状態
//   mixamo chars [--limit N] [--query 語] [--json]
//   mixamo char <name|uuid>                   プライマリキャラを切り替える
//   mixamo search <語> [--limit N] [--page N] [--json]
//   mixamo show <id|name>                     詳細（gms_hash / 長さ / loopable）
//   mixamo download <id|name> [--out DIR] [--format fbx7_2019|fbx7_unity|fbx7_2019_ascii|fbx7_2014|fbx6|dae_mixamo]
//                            [--skin true|false] [--fps 24|30|60] [--reducekf 0|1|2]
//                            [--inplace] [--mirror] [--overdrive N] [--trim 0-100] [--params "0"]
//                            [--char <uuid>] [--json]
//   mixamo batch <語> [--limit N] [--all] --out DIR [同じオプション]
//                                             検索結果をまとめて落とす（既定 5 件、--all で全ページ）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CDP = process.env.MIXAMO_CDP || 'http://127.0.0.1:9223';
const BASE = 'https://www.mixamo.com/api/v1';
const API_KEY = 'mixamo2';
const CONF_DIR = path.join(os.homedir(), '.config', 'mixamocli');
const CONF = path.join(CONF_DIR, 'credentials.json');

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, (v && !v.startsWith('--')) ? 2 : 1);
  return (v && !v.startsWith('--')) ? v : true;
};
const die = m => { console.error('mixamo: ' + m); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (o, asJson) => console.log(asJson ? JSON.stringify(o, null, 1) : o);

const FORMATS = {
  fbx7_2019: 'FBX Binary(.fbx)',
  fbx7_2019_ascii: 'FBX ASCII(.fbx)',
  fbx7_unity: 'FBX for Unity(.fbx)',
  fbx7_2014: 'FBX 7.4(.fbx)',
  fbx6: 'FBX 6.1(.fbx)',
  dae_mixamo: 'Collada(.dae)',
};
const EXT = { dae_mixamo: 'dae' };

// ---------- token ----------

function jwtExpiry(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8'));
    if (!p.rtea) return null;
    return new Date(Number(p.rtea));
  } catch { return null; }
}

function readConf() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; }
}

function saveConf(c) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function storedToken() {
  const env = process.env.MIXAMO_TOKEN;
  const cached = readConf().access_token;
  const t = env || cached;
  if (!t) return null;
  const exp = jwtExpiry(t);
  if (exp && exp.getTime() < Date.now() + 60_000) return null;
  return t;
}

/** トークンの出どころ。status で「どの経路を使っているか」を出すために使う。 */
function tokenSource() {
  const env = process.env.MIXAMO_TOKEN;
  const cached = readConf().access_token;
  if (env) return 'env:MIXAMO_TOKEN';
  if (cached) return 'file:' + CONF;
  return 'none';
}

async function cdpTabs() {
  try { return await (await fetch(CDP + '/json')).json(); } catch { return null; }
}

async function cdpEval(urlRe, expression) {
  const tabs = await cdpTabs();
  if (!tabs) throw new Error(`CDP に繋がらない (${CDP})`);
  const t = tabs.find(t => t.type === 'page' && urlRe.test(t.url));
  if (!t) throw new Error('Mixamo のタブが無い。mixamo login で開いて');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  ws.close();
  if (m.result?.exceptionDetails) throw new Error('ページ内エラー: ' + JSON.stringify(m.result.exceptionDetails).slice(0, 300));
  return m.result?.result?.value;
}

async function openTab(url) {
  const r = await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }).catch(() => null);
  if (!r || !r.ok) die(`CDP に繋がらない (${CDP})。ログイン済み Chrome を --remote-debugging-port 付きで開いて`);
  return r.json();
}

async function tokenFromCdp() {
  const tabs = await cdpTabs();
  if (!tabs) die(`CDP に繋がらない (${CDP})。常駐 Chrome を起動するか MIXAMO_CDP を設定して`);
  if (!tabs.some(t => t.type === 'page' && /^https:\/\/www\.mixamo\.com/.test(t.url))) {
    await openTab('https://www.mixamo.com/#/');
    await sleep(7000);
  }
  const tok = await cdpEval(/^https:\/\/www\.mixamo\.com/, 'localStorage.getItem("access_token")');
  if (!tok) die('Mixamo に未ログイン。mixamo login でログインして');
  return tok;
}

async function getToken() {
  const s = storedToken();
  if (s) return s;
  const t = await tokenFromCdp();
  // env で明示された値を CDP の値で上書きしない（意図した供給元を壊さないため）
  if (!process.env.MIXAMO_TOKEN) saveConf({ ...readConf(), access_token: t, saved_at: new Date().toISOString() });
  return t;
}

// ---------- api ----------

let TOKEN = null;
let TOKEN_REFRESHED = false;

async function api(method, url, body, { retry = 4 } = {}) {
  if (!TOKEN) TOKEN = await getToken();
  for (let attempt = 0; attempt <= retry; attempt++) {
    const headers = { authorization: 'Bearer ' + TOKEN, 'x-api-key': API_KEY, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status === 401) {
      TOKEN = await tokenFromCdp();
      TOKEN_REFRESHED = true;
      if (!process.env.MIXAMO_TOKEN) saveConf({ ...readConf(), access_token: TOKEN, saved_at: new Date().toISOString() });
      continue;
    }
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* not json */ }
    if (!r.ok) {
      const msg = json?.message || json?.error || txt.slice(0, 200);
      const err = new Error(`HTTP ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
    return json;
  }
  throw new Error('リクエストが 429 で失敗し続けた');
}

const detailsOf = p => (typeof p.details === 'string' ? JSON.parse(p.details) : (p.details || {}));

async function primaryChar() {
  return api('GET', '/characters/primary');
}

async function listCharacters(limit = 200, query = '') {
  // 注意: /characters の query パラメータはサーバー側で無視される（実測 2026-10-28）。ローカルで絞る。
  const list = await api('GET', `/characters?page=1&limit=${limit}`);
  if (!query) return list || [];
  const q = String(query).toLowerCase();
  return (list || []).filter(c => String(c.name).toLowerCase().includes(q));
}

/** 名前から uuid を解決する。完全一致 → 一意な部分一致 の順。曖昧なら候補を出して死ぬ。 */
async function resolveCharacter(term) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(term))) return String(term);
  const all = await listCharacters(200);
  const exact = all.find(c => c.name.toLowerCase() === String(term).toLowerCase());
  if (exact) return exact.uuid;
  const partial = all.filter(c => c.name.toLowerCase().includes(String(term).toLowerCase()));
  if (partial.length === 1) return partial[0].uuid;
  const near = partial.slice(0, 8).map(c => c.name).join(' / ');
  die(`キャラ特定できない: ${term}` + (near ? `（候補: ${near}）` : `（${all.length} 体中に該当なし）`));
}

async function searchProducts(query, limit = 48, page = 1) {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit), type: 'Motion,MotionPack', query: query || '' });
  return api('GET', '/products?' + qs);
}

async function findOne(term) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term)) {
    return api('GET', '/products/' + term);
  }
  const r = await searchProducts(term, 96, 1);
  const list = r.results || [];
  const exact = list.find(p => p.name.toLowerCase() === String(term).toLowerCase());
  const hit = exact || list[0];
  if (!hit) die(`見つからない: ${term}`);
  return api('GET', '/products/' + hit.id);
}

function gmsFrom(product, opts) {
  const d = detailsOf(product);
  const gh = d.gms_hash || {};
  return {
    'model-id': gh['model-id'],
    mirror: opts.mirror,
    trim: opts.trim,
    overdrive: opts.overdrive,
    params: opts.params,
    'arm-space': gh['arm-space'] ?? 0,
    inplace: opts.inplace,
  };
}

function parseOpts(get) {
  const fmt = String(get('format', 'fbx7_2019'));
  if (!FORMATS[fmt]) die(`未対応 format: ${fmt}（${Object.keys(FORMATS).join(' / ')}）`);
  const trimRaw = String(get('trim', '0-100'));
  const m = trimRaw.match(/^(\d+)[-,:](\d+)$/);
  if (!m) die('--trim は 0-100 の形式で');
  const skin = String(get('skin', 'true')) !== 'false';
  const fps = String(get('fps', '30'));
  if (!['24', '30', '60'].includes(fps)) die('--fps は 24 / 30 / 60');
  return {
    format: fmt,
    skin,
    fps,
    reducekf: String(get('reducekf', '0')),
    inplace: !!get('inplace', false),
    mirror: !!get('mirror', false),
    overdrive: Number(get('overdrive', 0)),
    trim: [Number(m[1]), Number(m[2])],
    params: String(get('params', '0')),
  };
}

async function exportOne(product, charId, opts, outDir, asJson) {
  const det = detailsOf(product);
  if (opts.inplace && det.supports_inplace === false) {
    console.error(`mixamo: 警告 — "${product.name}" は supports_inplace=false。--inplace を無視する（ジョブは通るが効果は無い）`);
    opts = { ...opts, inplace: false };
  }
  if (opts.trim[0] === opts.trim[1]) throw new Error(`--trim ${opts.trim[0]}-${opts.trim[1]} は幅 0。区間が空になる`);
  const body = {
    gms_hash: [gmsFrom(product, opts)],
    preferences: { format: opts.format, skin: String(opts.skin), fps: opts.fps, reducekf: opts.reducekf },
    character_id: charId,
    type: 'Motion',
    product_name: product.name,
  };
  const job = await api('POST', '/animations/export', body);
  if (!job?.job_uuid) throw new Error('job_uuid が返らなかった');
  let url = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1200);
    const mon = await api('GET', `/characters/${charId}/monitor?job_uuid=${job.job_uuid}`);
    if (mon.status === 'completed') { url = mon.job_result; break; }
    if (mon.status === 'failed') throw new Error('書き出し失敗: ' + JSON.stringify(mon.job_result).slice(0, 200));
  }
  if (!url) throw new Error('書き出しが 72 秒以内に終わらなかった');

  fs.mkdirSync(outDir, { recursive: true });
  const safe = String(product.name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  const ext = EXT[opts.format] || 'fbx';
  const dest = path.join(outDir, `${safe}.${ext}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`S3 取得 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  const rec = {
    id: product.id, name: product.name, file: dest, bytes: buf.length, format: opts.format,
    skin: opts.skin, fps: opts.fps, reducekf: opts.reducekf,
    inplace: opts.inplace, mirror: opts.mirror, overdrive: opts.overdrive, trim: opts.trim,
    character_id: charId, downloaded_at: new Date().toISOString(),
    duration: detailsOf(product).duration, loopable: detailsOf(product).loopable,
    supports_inplace: detailsOf(product).supports_inplace,
    source: `https://www.mixamo.com/#/?page=1&query=${encodeURIComponent(product.name)}`,
  };
  writeIndex(outDir, rec);
  return rec;
}

/** outDir の MIXAMO_SOURCE.json に 1 件追記する。batch と同じ形式（id で一意）。 */
function writeIndex(outDir, rec) {
  const index = path.join(outDir, 'MIXAMO_SOURCE.json');
  let prev = { items: [] };
  try { prev = JSON.parse(fs.readFileSync(index, 'utf8')); } catch { /* 新規 */ }
  const items = (prev.items || []).filter(x => x.id !== rec.id);
  items.push(rec);
  fs.writeFileSync(index, JSON.stringify({
    $comment: 'mixamo CLI の取得台帳。source は Mixamo (Adobe)、素材単体の再配布は不可',
    updated_at: new Date().toISOString(),
    items,
  }, null, 2));
}

/** 単発 download の失敗も batch と同じく failed:true で残す。既存の成功記録は上書きしない。 */
function recordFailure(outDir, product, message) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(outDir, 'MIXAMO_SOURCE.json'), 'utf8'));
    if ((prev.items || []).some(x => x.id === product.id && !x.failed)) return;
  } catch { /* 新規 */ }
  fs.mkdirSync(outDir, { recursive: true });
  writeIndex(outDir, { id: product.id, name: product.name, failed: true, error: message, failed_at: new Date().toISOString() });
}

// ---------- commands ----------

if (cmd === 'login') {
  await openTab('https://www.mixamo.com/#/');
  console.log('ログイン画面を開いた。済んだら mixamo status');
  process.exit(0);
}

if (cmd === 'token') {
  const set = flag('set', null);
  if (set) { saveConf({ ...readConf(), access_token: String(set), saved_at: new Date().toISOString() }); console.log('保存した'); process.exit(0); }
  const tok = await tokenFromCdp();
  const exp = jwtExpiry(tok);
  if (flag('save', false)) saveConf({ ...readConf(), access_token: tok, saved_at: new Date().toISOString() });
  console.log(JSON.stringify({ saved: !!flag('save', false), expires_at: exp ? exp.toISOString() : null, token_prefix: String(tok).slice(0, 12) + '…' }, null, 1));
  process.exit(0);
}

if (cmd === 'status') {
  const body = {};
  const tabs = await cdpTabs();
  body.cdp = tabs ? `ok (${CDP}, ${tabs.filter(t => t.type === 'page').length} tabs)` : `unreachable (${CDP})`;
  const src = tokenSource();
  const s = storedToken();
  body.token_source = src;
  body.stored_token = s ? `ok (expires ${jwtExpiry(s)?.toISOString() || 'unknown'})` : (src === 'none' ? 'none' : 'set but expired');
  try {
    const t = await getToken();
    body.token = `ok (expires ${jwtExpiry(t)?.toISOString() || 'unknown'})`;
    const p = await primaryChar();
    body.primary_character = `${p.primary_character_name} (${p.primary_character_id})`;
    body.api = 'ok';
    if (TOKEN_REFRESHED) {
      body.note = src.startsWith('env:')
        ? `MIXAMO_TOKEN が拒否されて CDP のトークンで回復した。env の値を更新しろ`
        : 'キャッシュのトークンが拒否されて CDP から取り直した（更新済み）';
    }
  } catch (e) {
    body.token = 'failed';
    body.api = e.message;
  }
  console.log(JSON.stringify(body, null, 1));
  process.exit(body.api === 'ok' ? 0 : 20);
}

if (cmd === 'chars') {
  const limit = +flag('limit', 96), asJson = flag('json', false);
  const query = String(flag('query', '') || argv.join(' '));
  const list = await listCharacters(limit, query);
  const rows = (list || []).map(c => ({ uuid: c.uuid, name: c.name, type: c.type, source: c.source, status: c.status }));
  out(asJson ? rows : rows.map(r => `${r.uuid}  ${r.name}${r.source === 'user' ? '  [uploaded]' : ''}`).join('\n'), false);
  process.exit(0);
}

if (cmd === 'char') {
  const term = argv[0];
  if (!term) die('mixamo char <name|uuid>');
  const uuid = await resolveCharacter(term);
  if (uuid !== term) console.log(`選択: ${term} → ${uuid}`);
  await api('POST', '/characters/update_primary', { primary_character_id: uuid });
  const p = await primaryChar();
  console.log(`primary: ${p.primary_character_name} (${p.primary_character_id})`);
  process.exit(0);
}

if (cmd === 'search') {
  const limit = +flag('limit', 48), page = +flag('page', 1), asJson = flag('json', false), withDetails = flag('details', false);
  const q = argv.join(' ');
  const r = await searchProducts(q, limit, page);
  const rows = [];
  for (const p of r.results || []) {
    const d = withDetails ? detailsOf(await api('GET', '/products/' + p.id)) : detailsOf(p);
    rows.push({ id: p.id, name: p.name, description: p.description, duration: d.duration, loopable: d.loopable, inplace: d.supports_inplace, modelId: d.gms_hash?.['model-id'], gif: p.thumbnail_animated });
  }
  if (asJson) out({ pagination: r.pagination, results: rows }, true);
  else {
    for (const x of rows) {
      const dur = x.duration != null ? String(x.duration).padStart(5) + 's' : '     ';
      console.log(`${x.id}  ${dur}  ${x.loopable ? 'loop' : '    '}  ${x.name}${x.description ? ' — ' + x.description : ''}`);
    }
    console.log(`(${r.pagination?.num_results ?? rows.length} 件中 ${rows.length} 件 / page ${page}/${r.pagination?.num_pages ?? 1})`);
    if (!withDetails) console.log('ヒント: 長さ・loop 可否は --details（1件ごとに追加取得）');
  }
  process.exit(0);
}

if (cmd === 'show') {
  const term = argv[0];
  if (!term) die('mixamo show <id|name>');
  const p = await findOne(term);
  const d = detailsOf(p);
  console.log(JSON.stringify({
    id: p.id, name: p.name, description: p.description, duration: d.duration, loopable: d.loopable,
    supports_inplace: d.supports_inplace, gms_hash: d.gms_hash, thumbnail: p.thumbnail_animated || p.thumbnail,
  }, null, 1));
  process.exit(0);
}

if (cmd === 'download') {
  const asJson = flag('json', false), outDir = path.resolve(String(flag('out', './mixamo-out')));
  const opts = parseOpts(flag);
  const charArg = flag('char', null);
  const term = argv[0];
  if (!term) die('mixamo download <id|name> --out DIR');
  const p = await findOne(term);
  const charId = charArg ? await resolveCharacter(charArg) : (await primaryChar()).primary_character_id;
  let rec;
  try { rec = await exportOne(p, charId, opts, outDir, asJson); }
  catch (e) { recordFailure(outDir, p, e.message); die(e.message); }
  out(asJson ? rec : `${rec.file}  (${(rec.bytes / 1024 / 1024).toFixed(2)} MB)  ${rec.name}`, false);
  process.exit(0);
}

if (cmd === 'batch') {
  const outDir = path.resolve(String(flag('out', './mixamo-out')));
  const limit = +flag('limit', 5), all = flag('all', false), asJson = flag('json', false);
  const opts = parseOpts(flag);
  const charArg = flag('char', null);
  const q = argv.join(' ');
  if (!q) die('mixamo batch <語> --out DIR [--limit N|--all]');
  const charId = charArg && /^[0-9a-f]{8}-/i.test(String(charArg)) ? String(charArg) : (await primaryChar()).primary_character_id;
  const found = [];
  for (let page = 1; ; page++) {
    const r = await searchProducts(q, 48, page);
    found.push(...(r.results || []));
    if (!all || page >= (r.pagination?.num_pages ?? 1) || found.length >= limit) break;
  }
  const targets = found.slice(0, all ? found.length : limit);
  const recs = []; const fails = [];
  for (const [i, p] of targets.entries()) {
    try {
      // 検索結果の product は details（gms_hash）を持たないので、書き出し前に単体取得する
      const full = await api('GET', '/products/' + p.id);
      const rec = await exportOne(full, charId, opts, outDir, asJson);
      recs.push(rec);
      if (!asJson) console.log(`[${i + 1}/${targets.length}] ok   ${rec.name}  ${(rec.bytes / 1024 / 1024).toFixed(2)}MB`);
    } catch (e) {
      fails.push({ id: p.id, name: p.name, error: e.message });
      if (!asJson) console.log(`[${i + 1}/${targets.length}] FAIL ${p.name}  ${e.message}`);
    }
    await sleep(1500);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const index = path.join(outDir, 'MIXAMO_SOURCE.json');
  const prev = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : { items: [] };
  const merged = [...(prev.items || []).filter(x => !recs.some(r => r.id === x.id)), ...recs, ...fails.map(f => ({ ...f, failed: true }))];
  fs.writeFileSync(index, JSON.stringify({ $comment: 'mixamo CLI の取得台帳。source は Mixamo (Adobe)、素材単体の再配布は不可', updated_at: new Date().toISOString(), items: merged }, null, 2));
  out(asJson ? { downloaded: recs, failed: fails, index } : `\n${recs.length} 件成功 / ${fails.length} 件失敗\n台帳: ${index}`, false);
  process.exit(fails.length && !recs.length ? 20 : 0);
}

console.log(`mixamo — Mixamo のアニメーションを CLI で取る

  mixamo login                        常駐 Chrome にログイン画面を開く
  mixamo status                       トークン / CDP / プライマリキャラ
  mixamo token [--save] [--set jwt]    トークンの取り直し・保存
  mixamo chars [--query 語] [--json]   キャラ一覧
  mixamo char <name|uuid>             プライマリキャラ切替（書き出し先の骨格）
  mixamo search <語> [--limit N] [--page N] [--json]
  mixamo show <id|name>               詳細（長さ / loopable / gms_hash）
  mixamo download <id|name> --out DIR [--format ${Object.keys(FORMATS).join('|')}]
                 [--skin true|false] [--fps 24|30|60] [--reducekf 0|1|2]
                 [--inplace] [--mirror] [--overdrive N] [--trim 0-100] [--params "0"] [--char <uuid>]
  mixamo batch <語> --out DIR [--limit N|--all] [同じオプション]

format: ${Object.entries(FORMATS).map(([k, v]) => k + '=' + v).join('  ')}
token は CDP Chrome (${CDP}) の Mixamo タブの localStorage から取る。MIXAMO_CDP / MIXAMO_TOKEN で上書き可`);
process.exit(2);
