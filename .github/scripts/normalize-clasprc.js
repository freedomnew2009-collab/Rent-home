/**
 * แปลงไฟล์ credential ของ clasp ให้อยู่ในรูปแบบที่ clasp 2.4.x อ่านได้
 *
 * clasp 2.4.x ต้องการ:  { token: {...}, oauth2ClientSettings: {...}, isLocalCreds: bool }
 * แต่ `clasp login` แต่ละเวอร์ชันเก็บไฟล์คนละแบบ:
 *   - v3     : { tokens: { default: { client_id, client_secret, refresh_token, type } } }
 *   - v2 เก่า : { access_token, refresh_token, scope, token_type, expiry_date }   (แบน)
 *   - v2 ใหม่ : { token: {...}, oauth2ClientSettings: {...}, isLocalCreds }        (ตรงอยู่แล้ว)
 *
 * อ่านค่าจาก env CLASPRC_JSON แล้วเขียนไฟล์ผลลัพธ์ตาม argv[2]
 * ไม่พิมพ์ค่าลับใด ๆ ออกทาง log — บอกแค่ว่าเจอรูปแบบไหน
 */
const fs = require('fs');

const OUT = process.argv[2];
if (!OUT) { console.error('ต้องระบุ path ปลายทาง'); process.exit(1); }

let raw;
try {
  raw = JSON.parse(process.env.CLASPRC_JSON || '');
} catch (e) {
  console.error('::error::CLASPRC_JSON ไม่ใช่ JSON ที่ถูกต้อง — คัดลอกเนื้อหาไฟล์ ~/.clasprc.json ทั้งไฟล์มาใส่');
  process.exit(1);
}

const REDIRECT = 'http://localhost';
let out = null, shape = '';

if (raw && raw.token && (raw.token.refresh_token || raw.token.access_token)) {
  // รูปแบบ clasp 2.4.x อยู่แล้ว
  shape = 'clasp v2 (token/oauth2ClientSettings)';
  out = raw;
  if (typeof out.isLocalCreds !== 'boolean') out.isLocalCreds = !!out.oauth2ClientSettings;
  if (out.isLocalCreds && !out.oauth2ClientSettings) out.isLocalCreds = false;
  out.token.expiry_date = 1;                       // บังคับให้ refresh token ใหม่
} else if (raw && raw.tokens && typeof raw.tokens === 'object') {
  // รูปแบบ clasp v3 — refresh_token ผูกกับ client ของผู้ใช้เอง
  const key = raw.tokens.default ? 'default' : Object.keys(raw.tokens)[0];
  const t = key ? raw.tokens[key] : null;
  if (!t || !t.refresh_token) {
    console.error('::error::ไม่พบ refresh_token ใน CLASPRC_JSON (รูปแบบ clasp v3)');
    process.exit(1);
  }
  shape = 'clasp v3 (tokens.' + key + ')';
  const hasClient = !!(t.client_id && t.client_secret);
  out = {
    token: {
      access_token: t.access_token || '',
      refresh_token: t.refresh_token,
      scope: t.scope || '',
      token_type: 'Bearer',
      expiry_date: 1
    },
    isLocalCreds: hasClient
  };
  if (hasClient) {
    out.oauth2ClientSettings = { clientId: t.client_id, clientSecret: t.client_secret, redirectUri: REDIRECT };
  }
} else if (raw && (raw.refresh_token || raw.access_token)) {
  // รูปแบบแบนของ clasp v2 รุ่นเก่า
  shape = 'clasp v2 (flat)';
  const hasClient = !!(raw.client_id && raw.client_secret);
  out = {
    token: {
      access_token: raw.access_token || '',
      refresh_token: raw.refresh_token,
      scope: raw.scope || '',
      token_type: raw.token_type || 'Bearer',
      expiry_date: 1
    },
    isLocalCreds: hasClient
  };
  if (hasClient) {
    out.oauth2ClientSettings = { clientId: raw.client_id, clientSecret: raw.client_secret, redirectUri: REDIRECT };
  }
}

if (!out || !out.token || !out.token.refresh_token) {
  console.error('::error::อ่าน refresh_token จาก CLASPRC_JSON ไม่ได้ — ตรวจว่าคัดลอกไฟล์ ~/.clasprc.json มาครบทั้งไฟล์');
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(out));
fs.chmodSync(OUT, 0o600);
console.log('✓ รูปแบบที่พบ: ' + shape);
console.log('✓ ใช้ OAuth client: ' + (out.isLocalCreds ? 'ของผู้ใช้เอง (local)' : 'ของ clasp (global)'));
console.log('✓ เขียนไฟล์ credential ให้ clasp เรียบร้อย');
