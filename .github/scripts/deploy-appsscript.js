/**
 * อัปโหลดโค้ดใน src/ ขึ้น Google Apps Script แล้ว (ถ้าตั้งค่าไว้) สร้างเวอร์ชันใหม่
 * ให้ deployment เดิม — เรียก Apps Script API ตรง ๆ ไม่ผ่าน clasp
 * จึงไม่ผูกกับรูปแบบไฟล์ credential ของ clasp แต่ละเวอร์ชัน
 *
 * ต้องมี env:
 *   CLASPRC_JSON  เนื้อหาไฟล์ ~/.clasprc.json (รองรับทั้ง clasp v2 และ v3)
 *   SCRIPT_ID     รหัสโปรเจกต์ Apps Script
 *   DEPLOYMENT_ID (ไม่บังคับ) ถ้ามี จะอัปเดตเว็บแอปเป็นเวอร์ชันใหม่บน URL เดิม
 *   VERSION_NOTE  (ไม่บังคับ) คำอธิบายเวอร์ชัน
 *
 * ไม่พิมพ์ค่าลับใด ๆ ออกทาง log
 */
const fs = require('fs');
const path = require('path');

// OAuth client สาธารณะของ clasp — ใช้เมื่อ credential ไม่ได้แนบ client มาด้วย
const CLASP_CLIENT = {
  id: '1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com',
  secret: 'v6V3fKV_zWU7iw1DrpO1rknX'
};

function fail(msg) { console.error('::error::' + msg); process.exit(1); }

/** ดึง {clientId, clientSecret, refreshToken} จากไฟล์ credential ทุกรูปแบบของ clasp */
function readCreds(rawText) {
  let raw;
  try { raw = JSON.parse(rawText); }
  catch (e) { fail('CLASPRC_JSON ไม่ใช่ JSON ที่ถูกต้อง — ให้คัดลอกเนื้อหาไฟล์ ~/.clasprc.json ทั้งไฟล์'); }

  let refreshToken = '', clientId = '', clientSecret = '', shape = '';

  if (raw && raw.tokens && typeof raw.tokens === 'object') {           // clasp v3
    const key = raw.tokens.default ? 'default' : Object.keys(raw.tokens)[0];
    const t = key ? raw.tokens[key] : null;
    if (t) {
      shape = 'clasp v3 (tokens.' + key + ')';
      refreshToken = t.refresh_token || '';
      clientId = t.client_id || '';
      clientSecret = t.client_secret || '';
    }
  } else if (raw && raw.token) {                                        // clasp v2 (token/...)
    shape = 'clasp v2 (token)';
    refreshToken = raw.token.refresh_token || '';
    const o = raw.oauth2ClientSettings || {};
    clientId = o.clientId || '';
    clientSecret = o.clientSecret || '';
  } else if (raw && (raw.refresh_token || raw.access_token)) {          // clasp v2 แบบแบน
    shape = 'clasp v2 (flat)';
    refreshToken = raw.refresh_token || '';
    clientId = raw.client_id || '';
    clientSecret = raw.client_secret || '';
  }

  if (!refreshToken) fail('อ่าน refresh_token จาก CLASPRC_JSON ไม่ได้ — ตรวจว่าคัดลอกไฟล์มาครบทั้งไฟล์');
  if (!clientId || !clientSecret) {
    clientId = CLASP_CLIENT.id; clientSecret = CLASP_CLIENT.secret;
    console.log('• credential ไม่ได้แนบ OAuth client มา จึงใช้ client ของ clasp');
  }
  console.log('✓ อ่าน credential สำเร็จ — รูปแบบ: ' + shape);
  return { clientId, clientSecret, refreshToken };
}

/** แลก refresh_token เป็น access_token */
async function getAccessToken(c) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId, client_secret: c.clientSecret,
      refresh_token: c.refreshToken, grant_type: 'refresh_token'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    fail('ขอ access token ไม่สำเร็จ (' + res.status + '): ' + (body.error_description || body.error || 'ไม่ทราบสาเหตุ') +
         '\nถ้าเป็น invalid_grant/invalid_client แปลว่า credential หมดอายุหรือคนละ OAuth client — ให้ clasp login ใหม่แล้วอัปเดต secret CLASPRC_JSON');
  }
  console.log('✓ ขอ access token สำเร็จ');
  return body.access_token;
}

async function api(token, method, url, payload) {
  const res = await fetch(url, {
    method: method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!res.ok) {
    const err = (body.error && (body.error.message || body.error.status)) || text.slice(0, 400);
    fail(method + ' ' + url.replace(/\/[\w-]{20,}/g, '/***') + ' ล้มเหลว (' + res.status + '): ' + err);
  }
  return body;
}

/** รวบรวมไฟล์ใน src/ เป็น payload ของ Apps Script API */
function collectFiles(dir) {
  const files = [];
  fs.readdirSync(dir).forEach(function (name) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return;
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext);
    let type = null;
    if (ext === '.gs' || ext === '.js') type = 'SERVER_JS';
    else if (ext === '.html') type = 'HTML';
    else if (name === 'appsscript.json') type = 'JSON';
    if (!type) return;
    files.push({ name: type === 'JSON' ? 'appsscript' : base, type: type, source: fs.readFileSync(full, 'utf8') });
  });
  if (!files.some(function (f) { return f.type === 'JSON'; })) fail('ไม่พบ src/appsscript.json');
  return files;
}

(async function main() {
  const scriptId = (process.env.SCRIPT_ID || '').trim();
  if (!scriptId) fail('ยังไม่ได้ตั้ง secret SCRIPT_ID');

  const creds = readCreds(process.env.CLASPRC_JSON || '');
  const token = await getAccessToken(creds);

  const files = collectFiles('src');
  console.log('• ไฟล์ที่จะอัปโหลด: ' + files.map(function (f) { return f.name + '(' + f.type + ')'; }).join(', '));

  await api(token, 'PUT', 'https://script.googleapis.com/v1/projects/' + scriptId + '/content', { files: files });
  console.log('✓ อัปโหลดโค้ดขึ้น Apps Script เรียบร้อย (' + files.length + ' ไฟล์)');

  const deploymentId = (process.env.DEPLOYMENT_ID || '').trim();
  if (!deploymentId) {
    console.log('::warning::ไม่ได้ตั้ง secret DEPLOYMENT_ID — โค้ดขึ้นแล้วแต่ยังไม่ได้สร้างเวอร์ชันใหม่ของเว็บแอป');
    console.log('  ให้กด Deploy → Manage deployments → ✏️ → New version เอง หรือเพิ่ม secret DEPLOYMENT_ID');
    return;
  }

  const note = (process.env.VERSION_NOTE || 'auto deploy').slice(0, 200);
  const version = await api(token, 'POST', 'https://script.googleapis.com/v1/projects/' + scriptId + '/versions', { description: note });
  console.log('✓ สร้างเวอร์ชันใหม่: v' + version.versionNumber);

  await api(token, 'PUT', 'https://script.googleapis.com/v1/projects/' + scriptId + '/deployments/' + deploymentId, {
    deploymentConfig: {
      scriptId: scriptId,
      versionNumber: version.versionNumber,
      manifestFileName: 'appsscript',
      description: note
    }
  });
  console.log('✓ อัปเดตเว็บแอปเป็น v' + version.versionNumber + ' แล้ว — URL เดิมไม่เปลี่ยน');
})().catch(function (e) { fail(String(e && e.message ? e.message : e)); });
