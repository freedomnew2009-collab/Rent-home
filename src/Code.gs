/**
 * Rent-home Web App
 * ------------------
 * เว็บแอปสำหรับบันทึกค่าใช้จ่ายบ้านเช่า (ค่าเช่า / ส่วนกลาง / ผ่อนบ้าน ฯลฯ)
 * พร้อมอัปโหลดรูปสลิปเข้า Google Drive โดยอัตโนมัติ แล้วเก็บลิงก์ลงใน Google Sheet
 *
 * ไฟล์นี้ทำงานฝั่งเซิร์ฟเวอร์ (Google Apps Script) ผูกกับสเปรดชีตของคุณ
 */

/** =========================================================================
 *  การตั้งค่า (แก้ได้ตามต้องการ)
 *  ========================================================================= */

// ⚙️ รหัสส่วนตัว (SPREADSHEET_ID / DRIVE_FOLDER_ID) เก็บใน "Script Properties"
//    ไม่ฝังในโค้ด เพื่อให้เปิด repo เป็น public ได้อย่างปลอดภัย
//    ตั้งค่าที่: Apps Script → ⚙️ Project Settings → Script Properties → Add
//      SPREADSHEET_ID = รหัสสเปรดชีต (จาก URL .../d/<ID>/edit)
//      DRIVE_FOLDER_ID = รหัสโฟลเดอร์เก็บสลิป (จาก URL โฟลเดอร์)  [ไม่ใส่ก็ได้]
//    อ่านค่าผ่านฟังก์ชัน prop_() ด้านล่าง
function prop_(key) {
  return (PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

// ชื่อชีต (แท็บ) ที่จะบันทึกข้อมูล ถ้าไม่พบจะใช้ชีตแรกของไฟล์
var SHEET_NAME = 'Database';

// แถวที่เป็นหัวตาราง (เริ่มนับจาก 1)
var HEADER_ROW = 2;

// ถ้าไม่ได้ตั้ง DRIVE_FOLDER_ID จะสร้าง/ใช้โฟลเดอร์ชื่อนี้ใน Drive อัตโนมัติ
var SLIP_FOLDER_NAME = 'Rent-home Slips';

// ✉️ อีเมลที่อนุญาตให้ใช้แอป (จำกัดเฉพาะบางคน)
//   *** ไม่เก็บอีเมลไว้ในโค้ด (repo เป็น public) — ใส่ใน Script Properties แทน ***
//   ตั้งที่: Apps Script → ⚙️ Project Settings → Script Properties → เพิ่ม
//      ALLOWED_USERS = you@gmail.com, someone@gmail.com   (คั่นด้วย comma)
//   - ไม่ตั้ง/เว้นว่าง = อนุญาตทุกคนที่มีบัญชี Google และมีลิงก์ (ตามสิทธิ์ตอน Deploy)
//   - มีรายชื่อ        = อนุญาตเฉพาะอีเมลในลิสต์เท่านั้น (ต้องใส่อีเมลตัวเองด้วย)
//   * ตั้งค่า Deploy → Who has access = "Anyone with a Google account" ด้วย

/** รายชื่ออีเมลที่อนุญาต (อ่านจาก Script Properties, คั่นด้วย comma/เว้นวรรค/ขึ้นบรรทัด) */
function allowedList_() {
  return prop_('ALLOWED_USERS').split(/[,;\s]+/).map(function (s) {
    return String(s).toLowerCase().trim();
  }).filter(Boolean);
}

/** อีเมลผู้ใช้ปัจจุบัน (อาจว่างสำหรับบางบัญชี consumer) */
function currentEmail_() {
  try { return (Session.getActiveUser().getEmail() || '').toLowerCase().trim(); }
  catch (e) { return ''; }
}

/** อนุญาตให้ใช้ไหม — true ถ้าไม่ได้จำกัด หรืออีเมลอยู่ในลิสต์ */
function isAllowed_() {
  var list = allowedList_();
  if (!list.length) return true;                   // ไม่ได้จำกัด
  var email = currentEmail_();
  if (!email) return false;                        // ระบุตัวตนไม่ได้ในโหมดจำกัด
  return list.indexOf(email) >= 0;
}

/**
 * รูปแบบการตั้งชื่อไฟล์สลิป — ให้ตรงกับที่ใช้ใน Google Drive อยู่แล้ว
 *   prefix      : คำนำหน้า (Rent / ส่วนกลาง / Bank)
 *   dateKey     : ใช้ "วันที่จ่าย" ช่องไหนมาตั้งชื่อ
 *   calendar    : 'greg' = ค.ศ. (ใช้ทุกหมวด)  |  'buddhist' = พ.ศ. (+543)
 *   granularity : 'day' = ปี-เดือน-วัน  |  'month' = ปี-เดือน
 *   suffix      : ต่อท้าย (ถ้ามี)
 * ตัวอย่าง: Rent_2026-07-10.jpg | ส่วนกลาง_2026-07-17.jpg | Bank_2026-07-17.jpg
 *           ส่วนกลาง_2026-05_เปลี่ยนนิติ.jpg
 */
var SLIP_NAMING = {
  rentSlip:     { prefix: 'Rent',     dateKey: 'rentDate',   calendar: 'greg',     granularity: 'day' },
  commonSlip:   { prefix: 'ส่วนกลาง', dateKey: 'commonDate', calendar: 'greg',     granularity: 'day' },
  extraSlip:    { prefix: 'Bank',     dateKey: 'extraDate',  calendar: 'greg',     granularity: 'day' },
  juristicSlip: { prefix: 'ส่วนกลาง', dateKey: 'commonDate', calendar: 'greg',     granularity: 'month', suffix: 'เปลี่ยนนิติ' },
  erSlip:       { prefix: 'ER',       dateKey: 'erDate',     calendar: 'greg',     granularity: 'day' },
  goldSlip:     { prefix: 'Gold',     dateKey: 'goldDate',   calendar: 'greg',     granularity: 'day' },
  taxSlip:      { prefix: 'Tax',      dateKey: 'taxDate',    calendar: 'greg',     granularity: 'day' }
};

/**
 * หมวดเงิน (โมเดล "กระแสเงิน" ของดีไซน์ Broadsheet)
 *   income=true คือเงินรับเข้า (ค่าเช่า) — ที่เหลือคือการจัดสรรออก
 *   แต่ละหมวดผูกกับคอลัมน์วันที่/จำนวน/สลิป ในชีตเดิม
 */
var CATEGORIES = [
  { key: 'rent',   name: 'ค่าเช่ารับเข้า',      dest: 'บัญชีเจ้าของบ้าน',   dateKey: 'rentDate',   amtKey: 'rentAmount',   slipKey: 'rentSlip',   income: true, color: 'var(--color-accent-800)' },
  // หมวดคงที่: ตัดจากเงินเดือนอัตโนมัติทุกเดือน ไม่ต้องบันทึก/แนบสลิป (virtual — ไม่ผูกคอลัมน์)
  //   startYM = เดือนเริ่มผ่อน (yyyy-mm, ค.ศ.) — เริ่ม ม.ค. 2025
  { key: 'loan',   name: 'ค่าผ่อนบ้าน',         dest: 'ตัดจากเงินเดือน',    fixed: true, defaultAmount: 3000, startYM: '2025-01', color: 'var(--color-accent-600)' },
  { key: 'extra',  name: 'ผ่อนบ้านเพิ่มเติม',   dest: 'ธนาคาร',             dateKey: 'extraDate',  amtKey: 'extraAmount',  slipKey: 'extraSlip',  color: 'var(--color-accent-700)' },
  { key: 'common', name: 'ค่าส่วนกลาง',         dest: 'นิติบุคคลหมู่บ้าน',   dateKey: 'commonDate', amtKey: 'commonAmount', slipKey: 'commonSlip', color: 'var(--color-accent-500)' },
  // slipOptional = แนบสลิปได้ แต่ไม่บังคับ (ไม่มีสลิปก็นับว่าจ่ายแล้ว)
  // planAmount  = ยอดที่ "กันไว้" ต่อเดือน — เดือนไหนยังไม่โอนจะขึ้นเป็นยอดค้างสะสม
  //               และโอนรวบหลายเดือนทีเดียวได้ (แก้ตัวเลขตรงนี้ได้ตามจริง)
  { key: 'er',     name: 'เงินสำรองฉุกเฉิน',    dest: 'บัญชีสำรอง (ER)',    dateKey: 'erDate',     amtKey: 'erAmount',     slipKey: 'erSlip',   slipOptional: true, planAmount: 500, color: 'var(--color-accent-400)' },
  { key: 'gold',   name: 'ลงทุนทองคำ',          dest: 'ออมทองคำ',           dateKey: 'goldDate',   amtKey: 'goldAmount',   slipKey: 'goldSlip', slipOptional: true, planAmount: 300, color: 'var(--color-accent-2-600)' },
  { key: 'tax',    name: 'กันภาษี',             dest: 'บัญชีภาษี',          dateKey: 'taxDate',    amtKey: 'taxAmount',    slipKey: 'taxSlip',  slipOptional: true, planAmount: 300, color: 'var(--color-accent-2-400)' }
];

/**
 * นิยามฟิลด์ทั้งหมด — เป็นแหล่งข้อมูลกลางที่ทั้งฝั่งเซิร์ฟเวอร์และหน้าเว็บใช้ร่วมกัน
 *   key       : ชื่ออ้างอิงภายในโปรแกรม
 *   header    : ชื่อหัวคอลัมน์ในชีต (ใช้จับคู่คอลัมน์อัตโนมัติ)
 *   defaultCol: ตำแหน่งคอลัมน์สำรอง (0 = A) เผื่อหาไม่เจอจากชื่อหัวตาราง
 *   label     : ข้อความที่แสดงบนหน้าเว็บ
 *   type      : date | number | text | file
 *   section   : กลุ่มของฟิลด์ (ใช้จัดหน้าเว็บ)
 */
var FIELDS = [
  { key: 'rentDate',    header: 'วันที่จ่ายค่าเช่า',      defaultCol: 0,  label: 'วันที่จ่าย',   type: 'date',   section: 'rent' },
  { key: 'rentAmount',  header: 'จำนวนค่าเช่า',          defaultCol: 1,  label: 'จำนวนเงิน',    type: 'number', section: 'rent' },
  { key: 'rentSlip',    header: 'สลิปค่าเช่า',            defaultCol: 2,  label: 'สลิปค่าเช่า',   type: 'file',   section: 'rent' },

  { key: 'commonDate',  header: 'วันที่จ่ายค่าส่วนกลาง',  defaultCol: 3,  label: 'วันที่จ่าย',   type: 'date',   section: 'common' },
  { key: 'commonAmount',header: 'ค่าส่วนกลาง',           defaultCol: 4,  label: 'จำนวนเงิน',    type: 'number', section: 'common' },
  { key: 'commonSlip',  header: 'สลิปจ่ายส่วนกลาง',       defaultCol: 5,  label: 'สลิปส่วนกลาง',  type: 'file',   section: 'common' },
  { key: 'juristicSlip',header: 'เปลี่ยนนิติ',            defaultCol: 6,  label: 'สลิปเปลี่ยนนิติ (ถ้ามี)', type: 'file', section: 'common' },

  { key: 'extraDate',   header: 'วันที่จ่ายบ้านเพิ่มเติม', defaultCol: 7,  label: 'วันที่จ่าย',   type: 'date',   section: 'extra' },
  { key: 'extraAmount', header: 'ค่าผ่อนบ้านเพิ่มเติม',    defaultCol: 8,  label: 'จำนวนเงิน',    type: 'number', section: 'extra' },
  { key: 'extraSlip',   header: 'สลิปจ่ายบ้านเพิ่มเติม',   defaultCol: 9,  label: 'สลิปผ่อนบ้าน',  type: 'file',   section: 'extra' },

  { key: 'installment', header: 'งวดที่',                 defaultCol: 10, label: 'งวดที่',       type: 'text',   section: 'info' },

  { key: 'erDate',      header: 'วันที่เก็บ ER',          defaultCol: 11, label: 'วันที่เก็บ',   type: 'date',   section: 'er' },
  { key: 'erAmount',    header: 'Emergency',              defaultCol: 12, label: 'จำนวนเงิน',    type: 'number', section: 'er' },

  { key: 'goldDate',    header: 'วันที่ลงทุน Gold Now',   defaultCol: 13, label: 'วันที่ลงทุน',  type: 'date',   section: 'gold' },
  { key: 'goldAmount',  header: 'Gold now',               defaultCol: 14, label: 'จำนวนเงิน',    type: 'number', section: 'gold' },

  { key: 'taxDate',     header: 'วันที่เตรยมจ่ายภาษี',    defaultCol: 15, label: 'วันที่เตรียมจ่าย', type: 'date', section: 'tax' },
  { key: 'taxAmount',   header: 'เงินจ่ายภาษี',           defaultCol: 16, label: 'จำนวนเงิน',    type: 'number', section: 'tax' },

  // ช่องสลิปเพิ่มเติม (คอลัมน์ใหม่ — ระบบเพิ่มหัวคอลัมน์ให้อัตโนมัติเมื่อใช้ครั้งแรก)
  { key: 'erSlip',      header: 'สลิปเก็บ ER',            defaultCol: 17, label: 'สลิป ER',      type: 'file',   section: 'er' },
  { key: 'goldSlip',    header: 'สลิปลงทุนทองคำ',         defaultCol: 18, label: 'สลิปทองคำ',    type: 'file',   section: 'gold' },
  { key: 'taxSlip',     header: 'สลิปจ่ายภาษี',           defaultCol: 19, label: 'สลิปภาษี',     type: 'file',   section: 'tax' }
];

/** ช่องสลิปที่ระบบเพิ่มหัวคอลัมน์ให้เองถ้ายังไม่มีในชีต */
var AUTO_SLIP_FIELDS = ['erSlip', 'goldSlip', 'taxSlip'];

/**
 * เพิ่มหัวคอลัมน์สลิปที่ยังไม่มีในชีต — ปลอดภัยกับข้อมูลเดิม
 * ถ้าคอลัมน์ตำแหน่งเริ่มต้นมีข้อมูลอยู่ จะไปสร้างคอลัมน์ใหม่ท้ายตารางแทน
 */
/** ชื่อหัวคอลัมน์ของฟิลด์ (ใช้ในข้อความแจ้งผู้ใช้) */
function slipHeaderOf_(fieldKey) {
  for (var i = 0; i < FIELDS.length; i++) { if (FIELDS[i].key === fieldKey) return FIELDS[i].header; }
  return fieldKey;
}

/** มีหัวคอลัมน์ของฟิลด์นี้อยู่จริงในชีตไหม (ใช้เช็กก่อนเขียนสลิป) */
function hasHeaderFor_(sheet, hr, fieldKey) {
  var f = null;
  for (var i = 0; i < FIELDS.length; i++) { if (FIELDS[i].key === fieldKey) { f = FIELDS[i]; break; } }
  if (!f) return false;
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(hr, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h == null ? '' : h).replace(/\s+/g, ' ').trim();
  });
  return headers.indexOf(f.header) >= 0;
}

function ensureSlipHeaders_(sheet, hr) {
  var lastRow = sheet.getLastRow();
  AUTO_SLIP_FIELDS.forEach(function (key) {
    var f = null;
    for (var i = 0; i < FIELDS.length; i++) { if (FIELDS[i].key === key) { f = FIELDS[i]; break; } }
    if (!f) return;

    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var headers = sheet.getRange(hr, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h == null ? '' : h).replace(/\s+/g, ' ').trim();
    });
    if (headers.indexOf(f.header) >= 0) return;         // มีหัวคอลัมน์นี้อยู่แล้ว

    // คอลัมน์ตำแหน่งเริ่มต้นใช้ได้ไหม (หัวว่าง และไม่มีข้อมูลด้านล่าง)
    var col = f.defaultCol + 1, usable = false;
    if (col <= lastCol && headers[f.defaultCol] === '') {
      usable = true;
      if (lastRow > hr) {
        var vals = sheet.getRange(hr + 1, col, lastRow - hr, 1).getValues();
        for (var r = 0; r < vals.length; r++) {
          if (String(vals[r][0]).trim() !== '') { usable = false; break; }
        }
      }
    } else if (col > lastCol) {
      usable = true;                                     // เลยขอบตาราง = คอลัมน์ว่าง
    }
    if (!usable) col = sheet.getLastColumn() + 1;        // มีข้อมูลปน -> ต่อท้ายตาราง
    try {
      sheet.getRange(hr, col).setValue(f.header);
    } catch (e) {
      // ชีตที่ใช้ "ตาราง" ของ Google Sheets อาจไม่ยอมให้เพิ่มคอลัมน์ —
      // ข้ามไป แล้วจะไม่เขียนสลิปหมวดนี้ (ดูการเช็กด้วย hasHeaderFor_)
    }
  });
}

// ข้อมูลของแต่ละกลุ่ม (ใช้แสดงหัวข้อ/ไอคอนบนหน้าเว็บ)
var SECTIONS = [
  { key: 'info',   title: 'ข้อมูลงวด',          icon: '🗓️' },
  { key: 'rent',   title: 'ค่าเช่า',            icon: '🏠' },
  { key: 'common', title: 'ค่าส่วนกลาง',        icon: '🏢' },
  { key: 'extra',  title: 'ผ่อนบ้านเพิ่มเติม',   icon: '🏦' },
  { key: 'er',     title: 'เงินฉุกเฉิน (ER)',    icon: '🚨' },
  { key: 'gold',   title: 'ลงทุนทองคำ (Gold Now)', icon: '🪙' },
  { key: 'tax',    title: 'ภาษี',              icon: '🧾' }
];

/** =========================================================================
 *  จุดเริ่มต้นของเว็บแอป
 *  ========================================================================= */

function doGet(e) {
  // จำกัดสิทธิ์: ถ้าตั้ง ALLOWED_USERS ไว้และบัญชีนี้ไม่อยู่ในลิสต์ -> แสดงหน้าปฏิเสธ
  if (!isAllowed_()) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;text-align:center;color:#2d2b2b">' +
      '<h2>ไม่มีสิทธิ์เข้าใช้แอป</h2>' +
      '<p>บัญชี <b>' + (currentEmail_() || '(ไม่ทราบ)') + '</b> ไม่ได้รับอนุญาต<br>' +
      'กรุณาติดต่อเจ้าของแอปเพื่อขอสิทธิ์</p></div>'
    ).setTitle('Rent-home');
  }
  // โหมดตรวจสอบ: เปิด <exec-url>?debug=1 เพื่อดูว่ากำลังอ่านแท็บไหน + แต่ละแท็บมีกี่แถว
  if (e && e.parameter && e.parameter.debug) {
    return ContentService
      .createTextOutput(JSON.stringify(debugInfo_(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Rent-home | บันทึกค่าใช้จ่ายบ้าน')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // อนุญาตให้ฝังหน้านี้เป็น iframe จากโดเมนอื่น (ตัวเปิดแอป PWA บน GitHub Pages)
    // เพื่อให้เปิดแบบเต็มจอได้ ไม่มีแถบ script.google.com ด้านบน
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico');
}

/** ข้อมูลตรวจสอบ: ชื่อสเปรดชีต, แท็บที่กำลังอ่าน, และทุกแท็บพร้อมจำนวนแถว/งวดจริง */
function debugInfo_() {
  var info = { SHEET_NAME: SHEET_NAME, HEADER_ROW: HEADER_ROW, hasSpreadsheetIdProp: !!prop_('SPREADSHEET_ID') };
  try {
    var id = prop_('SPREADSHEET_ID');
    var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    info.spreadsheetName = ss.getName();
    var reading = getSheet_();
    info.readingTab = reading.getName();
    info.detectedHeaderRow = headerRow_(reading);
    var recs = getRecords();
    info.recordsCounted = recs.length;           // งวดจริงที่นับได้จากแท็บที่อ่าน
    if (recs.length) {
      var rowsList = recs.map(function (r) { return r.row; });
      info.rowRange = Math.min.apply(null, rowsList) + '–' + Math.max.apply(null, rowsList);
      info.withNgwodLabel = recs.filter(function (r) { return /งวดที่/.test(String(r.installment || '')); }).length;
      info.withRentAmount = recs.filter(function (r) { return String(r.rentAmount || '').replace(/[^0-9.]/g, '') !== ''; }).length;
      var line = function (r) { return r.row + ': [' + (r.installment || '-') + '] ' + (r.rentDate || '-') + ' / ' + (r.rentAmount || '-') + ' / common:' + (r.commonAmount || '-'); };
      info.firstRows = recs.slice(-8).reverse().map(line);  // แถวบนสุดของชีต (เก่าสุด)
      info.lastRows = recs.slice(0, 8).map(line);           // แถวล่างสุดของชีต (ใหม่สุด)
    }
    info.tabs = ss.getSheets().map(function (s) {
      return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() };
    });
  } catch (err) {
    info.error = String(err && err.message ? err.message : err);
  }
  return info;
}

/** ให้ HTML ไฟล์อื่น include เข้ามาได้ (เช่น CSS/JS) */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** =========================================================================
 *  ตัวช่วยเข้าถึงชีตและคอลัมน์
 *  ========================================================================= */

function getSheet_() {
  var id = prop_('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('ยังไม่ได้ตั้งค่า SPREADSHEET_ID — ไปที่ Apps Script → Project Settings → Script Properties แล้วเพิ่ม SPREADSHEET_ID');
  }
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.getSheets()[0];
  return sheet;
}

/**
 * สร้างแผนที่ key -> ดัชนีคอลัมน์ (0-based)
 * โดยพยายามจับคู่จากชื่อหัวตารางก่อน ถ้าไม่พบใช้ defaultCol
 */
/**
 * หาแถวหัวตารางอัตโนมัติ โดยหาแถวที่ช่องแรกเป็น "วันที่จ่ายค่าเช่า"
 * (ค้นใน 6 แถวแรก) — เผื่อหัวอยู่แถว 1 หรือ 2 ถ้าไม่เจอใช้ HEADER_ROW
 */
function headerRow_(sheet) {
  var n = Math.min(6, Math.max(sheet.getLastRow(), 1));
  var col1 = sheet.getRange(1, 1, n, 1).getValues();
  for (var r = 0; r < col1.length; r++) {
    var v = String(col1[r][0] == null ? '' : col1[r][0]).replace(/\s+/g, ' ').trim();
    if (v === 'วันที่จ่ายค่าเช่า') return r + 1;
  }
  return HEADER_ROW;
}

function getColumnMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(headerRow_(sheet), 1, 1, lastCol).getValues()[0];
  var normalized = headers.map(function (h) {
    return String(h == null ? '' : h).replace(/\s+/g, ' ').trim();
  });

  var map = {};
  FIELDS.forEach(function (f) {
    var target = f.header.replace(/\s+/g, ' ').trim();
    var idx = normalized.indexOf(target);
    map[f.key] = (idx >= 0) ? idx : f.defaultCol;
  });
  return map;
}

function maxColumnIndex_(map) {
  var max = 0;
  Object.keys(map).forEach(function (k) { if (map[k] > max) max = map[k]; });
  return max;
}

/** =========================================================================
 *  API สำหรับหน้าเว็บ
 *  ========================================================================= */

/** ส่งโครงสร้างฟอร์ม (ฟิลด์ + กลุ่ม) ให้หน้าเว็บนำไปสร้าง UI */
function getFormConfig() {
  return { fields: FIELDS, sections: SECTIONS };
}

/**
 * ดึงรายการที่บันทึกไว้ (ล่าสุดอยู่บน) เพื่อแสดงบนหน้าเว็บ
 */
function getRecords() {
  if (!isAllowed_()) return [];
  var sheet = getSheet_();
  var map = getColumnMap_(sheet);
  var startRow = headerRow_(sheet) + 1;
  var lastRow = sheet.getLastRow();
  var records = [];

  if (lastRow >= startRow) {
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
    var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();

    values.forEach(function (row, i) {
      var rec = { row: startRow + i };

      // นับเป็น "งวดจริง" เฉพาะแถวที่มี "วันที่จ่ายจริง" อย่างน้อยหนึ่งช่อง
      // กันทั้งแถวขยะ (เช่น "ดูสลิป") และแถวที่ตั้งจำนวนเงินไว้ล่วงหน้า/สูตร
      // ที่ยังไม่ได้จ่ายจริง (ไม่มีวันที่) ไม่ให้นับเป็นงวด
      var hasData = false;
      FIELDS.forEach(function (f) {
        var v = formatCellForClient_(row[map[f.key]], f.type);
        rec[f.key] = v;
        if (f.type === 'date' && v && /\d/.test(v)) hasData = true;
      });

      if (hasData) records.push(rec);
    });
  }

  records.reverse(); // ล่าสุดอยู่บนสุด
  return records;
}

function formatCellForClient_(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (type === 'date') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
    return v.toISOString();
  }
  return String(v);
}

/**
 * บันทึกข้อมูล 1 รายการ (เพิ่มใหม่ หรือแก้ไขแถวเดิม)
 *
 * @param {Object} payload
 *   payload.row    {number}  ถ้ามี = แก้ไขแถวนั้น, ถ้าไม่มี = เพิ่มใหม่
 *   payload.values {Object}  key ของฟิลด์ -> ค่า (ฟิลด์ file จะเป็น {name, mimeType, data})
 * @return {Object} ผลลัพธ์
 */
function saveRecord(payload) {
  try {
    return saveRecord_(payload);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function saveRecord_(payload) {
  if (!isAllowed_()) return { ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // กันการบันทึกพร้อมกันจนข้อมูลชนกัน
  try {
    var sheet = getSheet_();
    var hr = headerRow_(sheet);
    var map = getColumnMap_(sheet);
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);

    var isEdit = payload.row && Number(payload.row) > hr;
    var targetRow = isEdit ? Number(payload.row) : sheet.getLastRow() + 1;
    if (targetRow <= hr) targetRow = hr + 1;

    // อ่านค่าเดิมของแถว (กรณีแก้ไข จะได้ไม่ลบข้อมูลที่ไม่ได้แตะ)
    var rowValues = new Array(width).fill('');
    if (isEdit && targetRow <= sheet.getLastRow()) {
      rowValues = sheet.getRange(targetRow, 1, 1, width).getValues()[0];
    }

    var values = payload.values || {};

    FIELDS.forEach(function (f) {
      var col = map[f.key];
      if (!(f.key in values)) return; // ไม่ได้ส่งฟิลด์นี้มา -> คงค่าเดิม

      var raw = values[f.key];

      if (f.type === 'file') {
        if (raw && raw.data) {
          rowValues[col] = uploadFileToDrive_(raw, f.key, values);
        }
        // ถ้าไม่ได้แนบไฟล์ใหม่ -> คงลิงก์เดิมไว้
      } else if (f.type === 'number') {
        rowValues[col] = (raw === '' || raw === null) ? '' : Number(raw);
      } else {
        rowValues[col] = (raw === null || raw === undefined) ? '' : String(raw);
      }
    });

    sheet.getRange(targetRow, 1, 1, width).setValues([rowValues]);

    return { ok: true, row: targetRow, edited: isEdit };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

// หมายเหตุ: ไม่ตั้งรูปแบบสกุลเงินด้วย setNumberFormat อีกต่อไป
// ชีตนี้ใช้ "ตาราง" ของ Google Sheets ซึ่งล็อกชนิดคอลัมน์ไว้ และจะคืน error
// "You can't set the number format of cells in a typed column." — ตัวชีตจัดรูปแบบเงินให้เองอยู่แล้ว

/** =========================================================================
 *  อัปโหลดรูปเข้า Google Drive
 *  ========================================================================= */

function getSlipFolder_() {
  var id = prop_('DRIVE_FOLDER_ID');
  if (id) {
    return DriveApp.getFolderById(id);
  }
  var it = DriveApp.getFoldersByName(SLIP_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(SLIP_FOLDER_NAME);
}

/**
 * อัปโหลดไฟล์ (base64) เข้า Drive แล้วคืนค่า URL ที่เปิดดูได้
 * @param {Object} fileObj  {name, mimeType, data(base64 ไม่รวม prefix)}
 * @param {string} fieldKey key ของช่องสลิป (เช่น rentSlip)
 * @param {Object} values   ค่าจากฟอร์มทั้งหมด (ใช้ดึงวันที่มาตั้งชื่อไฟล์)
 */
function uploadFileToDrive_(fileObj, fieldKey, values) {
  var folder = getSlipFolder_();
  var bytes = Utilities.base64Decode(fileObj.data);
  var safeName = buildSlipName_(fileObj, fieldKey, values || {});
  var blob = Utilities.newBlob(bytes, fileObj.mimeType || 'application/octet-stream', safeName);
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // บางองค์กรปิดการแชร์แบบ anyone-with-link ไว้ — ปล่อยผ่าน ไฟล์ยังถูกบันทึก
  }
  return file.getUrl();
}

/**
 * ตั้งชื่อไฟล์สลิปตามรูปแบบใน Google Drive (ดู SLIP_NAMING)
 * เช่น Rent_2026-07-10.jpg, ส่วนกลาง_2569-07-17.jpg, Bank_2026-07-17.jpg
 * ถ้าไม่มีวันที่ในฟอร์ม จะใช้วันที่ปัจจุบันแทน
 */
function buildSlipName_(fileObj, fieldKey, values) {
  var ext = extractExt_(fileObj);
  var cfg = SLIP_NAMING[fieldKey];

  // ช่องสลิปที่ไม่มีในตารางตั้งชื่อ -> ใช้ชื่อเดิม + วันเวลา
  if (!cfg) {
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
    return (fieldKey || 'slip') + '_' + stamp + ext;
  }

  var parts = parseThaiDate_(values[cfg.dateKey]) || todayParts_();
  var year = (cfg.calendar === 'buddhist') ? parts.y + 543 : parts.y;
  var dateStr = (cfg.granularity === 'month')
    ? year + '-' + pad2_(parts.m)
    : year + '-' + pad2_(parts.m) + '-' + pad2_(parts.d);

  var name = cfg.prefix + '_' + dateStr;
  if (cfg.suffix) name += '_' + cfg.suffix;
  return name + ext;
}

/** ดึงนามสกุลไฟล์จากชื่อเดิม ถ้าไม่มีให้เดาจาก mimeType (ค่าเริ่มต้น .jpg) */
function extractExt_(fileObj) {
  var original = fileObj && fileObj.name ? String(fileObj.name) : '';
  if (original.indexOf('.') >= 0) {
    return original.substring(original.lastIndexOf('.')).toLowerCase();
  }
  var mt = (fileObj && fileObj.mimeType) ? String(fileObj.mimeType).toLowerCase() : '';
  if (mt.indexOf('png') >= 0) return '.png';
  if (mt.indexOf('webp') >= 0) return '.webp';
  if (mt.indexOf('heic') >= 0) return '.heic';
  if (mt.indexOf('gif') >= 0) return '.gif';
  return '.jpg';
}

/** แปลงวันที่รูปแบบ dd/MM/yyyy (จากฟอร์ม) -> {y, m, d} แบบ ค.ศ. */
function parseThaiDate_(str) {
  if (!str) return null;
  var p = String(str).trim().split('/');
  if (p.length !== 3) return null;
  var d = parseInt(p[0], 10), m = parseInt(p[1], 10), y = parseInt(p[2], 10);
  if (!d || !m || !y) return null;
  // เผื่อกรณีมีคนกรอกเป็น พ.ศ. มา (ปี > 2400) ให้แปลงกลับเป็น ค.ศ.
  if (y > 2400) y -= 543;
  return { y: y, m: m, d: d };
}

function todayParts_() {
  var now = new Date();
  var s = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd').split('-');
  return { y: parseInt(s[0], 10), m: parseInt(s[1], 10), d: parseInt(s[2], 10) };
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** =========================================================================
 *  API สำหรับดีไซน์ใหม่ (Broadsheet) — โมเดลกระแสเงิน
 *  ========================================================================= */

var THAI_MONTHS_ = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function toNumber_(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** yyyy-mm (ค.ศ.) จากวันที่ dd/MM/yyyy เช่น "10/02/2026" -> "2026-02" */
function ymOf_(dateStr) {
  var p = parseThaiDate_(dateStr);
  return p ? (p.y + '-' + pad2_(p.m)) : '';
}

/**
 * "เดือนของแถว" (yyyy-mm) ใช้ระบุว่าแถวนี้คืองวดของเดือนไหน
 * ยึดวันที่จ่ายค่าเช่าเป็นหลัก ถ้าไม่มีใช้วันที่แรกที่เจอในแถว
 */
function rowYM_(rowValues, map) {
  var ym = ymOf_(cellToDateStr_(rowValues[map.rentDate]));
  if (ym) return ym;
  for (var i = 0; i < CATEGORIES.length; i++) {
    var c = CATEGORIES[i];
    if (c.income || c.fixed || !c.dateKey) continue;
    ym = ymOf_(cellToDateStr_(rowValues[map[c.dateKey]]));
    if (ym) return ym;
  }
  return '';
}

/** ค่าจากเซลล์ -> ข้อความวันที่ dd/MM/yyyy (รองรับทั้ง Date และข้อความ) */
function cellToDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return String(v == null ? '' : v).trim();
}

/** เลขงวดถัดไป เช่น มีถึง "งวดที่ 18" -> "งวดที่ 19" */
function nextInstallment_(block, map) {
  var max = 0;
  block.forEach(function (row) {
    var m = String(row[map.installment] || '').match(/(\d+)/);
    if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
  });
  return 'งวดที่ ' + (max + 1);
}

/** ป้ายเดือน-ปี (ค.ศ.) จากวันที่ dd/MM/yyyy เช่น "ก.ค. 2026" */
function thaiMonthLabel_(dateStr, fallback) {
  var p = parseThaiDate_(dateStr);
  if (!p) return fallback || '';
  return THAI_MONTHS_[p.m - 1] + ' ' + p.y;
}

/** คำนวณสถานะของการจัดสรรจากข้อมูลที่มีในแถว */
function deriveStatus_(cat, amt, dateStr, slip) {
  var hasAmt = amt > 0;
  var hasDate = !!(dateStr && String(dateStr).trim());
  var hasSlip = slip && /^https?:\/\//.test(String(slip));
  if (!hasAmt && !hasDate && !hasSlip) return 'none';   // ยังไม่ตั้ง/ข้ามเดือนนี้
  if (hasSlip) return 'paid';
  if (cat.slipKey && !cat.slipOptional) {  // หมวดที่ต้องมีสลิป
    return (hasAmt && hasDate) ? 'waiting_slip' : 'waiting_transfer';
  }
  return (hasAmt && hasDate) ? 'paid' : 'waiting_transfer';   // หมวดที่สลิปไม่บังคับ
}

/**
 * ข้อมูลหน้า "จัดเงิน" (Dashboard) ของเดือนหนึ่ง
 * @param {number} offset 0 = เดือนล่าสุด, 1 = ก่อนหน้า, ...
 */
function getDashboard(offset) {
  if (!isAllowed_()) return { hasData: false, denied: true };
  offset = Number(offset) || 0;
  var recs = getRecords();               // ใหม่สุดอยู่บน, เฉพาะแถวที่มีข้อมูล
  if (!recs.length) return { hasData: false };
  if (offset < 0) offset = 0;
  if (offset > recs.length - 1) offset = recs.length - 1;

  var r = recs[offset];
  var incomeCat = CATEGORIES[0];         // rent
  var income = toNumber_(r[incomeCat.amtKey]);

  var allocations = [];
  CATEGORIES.forEach(function (c) {
    if (c.income) return;
    if (c.fixed) {   // ค่าคงที่ ตัดจากเงินเดือนอัตโนมัติ ไม่ต้องบันทึก
      var ym = ymOf_(r[incomeCat.dateKey]);            // เดือนของแถวนี้ (yyyy-mm)
      if (c.startYM && ym && ym < c.startYM) return;   // เดือนก่อนเริ่มผ่อน — ไม่แสดง
      allocations.push({
        key: c.key, name: c.name, dest: c.dest, color: c.color,
        amount: c.defaultAmount || 0, date: '', slip: '', status: 'auto', fixed: true
      });
      return;
    }
    var amt = toNumber_(r[c.amtKey]);
    var date = r[c.dateKey] || '';
    var slip = c.slipKey ? (r[c.slipKey] || '') : '';
    var status = deriveStatus_(c, amt, date, slip);
    var accrued = false;
    // หมวดที่กันเงินไว้ทุกเดือน (ER/ทอง/ภาษี) — ถ้ายังไม่มีวันที่โอน ถือเป็น "ค้างสะสม"
    if (c.planAmount && !(date && /\d/.test(String(date)))) {
      accrued = true;
      status = 'accrued';
      if (!(amt > 0)) amt = c.planAmount;
    }
    allocations.push({
      key: c.key, name: c.name, dest: c.dest, color: c.color,
      amount: amt, date: date, slip: slip, status: status, accrued: accrued
    });
  });

  return {
    hasData: true,
    offset: offset,
    hasOlder: offset < recs.length - 1,
    hasNewer: offset > 0,
    row: r.row,
    installment: r.installment || '',
    monthLabel: thaiMonthLabel_(r[incomeCat.dateKey], r.installment || ''),
    income: income,
    incomeDate: r[incomeCat.dateKey] || '',
    incomeSlip: r[incomeCat.slipKey] || '',
    allocations: allocations
  };
}

/**
 * บันทึกการจัดสรร 1 หมวด ลงในแถวของงวดนั้น (อัปเดตคอลัมน์เฉพาะหมวด)
 * ถ้าไม่พบงวด จะเพิ่มแถวใหม่
 * @param {Object} payload {row?, category, amount, date, installment, slip?}
 */
/**
 * ตัวห่อกัน exception หลุดไปถึงหน้าเว็บ (google.script.run จะเรียก failure handler
 * และผู้ใช้จะเห็น "เกิดข้อผิดพลาด" ทั้งที่ข้อมูลอาจถูกบันทึกไปแล้ว)
 * ทุกกรณีจะคืนเป็น { ok: true/false } เสมอ
 */
function saveAllocation(payload) {
  try {
    return saveAllocation_(payload);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function saveAllocation_(payload) {
  if (!isAllowed_()) return { ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cat = null;
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === payload.category) { cat = CATEGORIES[i]; break; }
    }
    if (!cat) return { ok: false, error: 'หมวดไม่ถูกต้อง' };
    if (cat.fixed) return { ok: false, error: 'หมวดนี้เป็นยอดคงที่ (ตัดจากเงินเดือน) ไม่ต้องบันทึก' };

    var sheet = getSheet_();
    var hr = headerRow_(sheet);
    if (payload.slip && payload.slip.data) ensureSlipHeaders_(sheet, hr);  // เพิ่มคอลัมน์สลิปถ้ายังไม่มี
    var map = getColumnMap_(sheet);
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
    var installment = String(payload.installment || '').trim();

    // ---- หาแถวเป้าหมาย ----
    // สำคัญ: ยึด "เดือนของวันที่ที่กรอก" เป็นหลัก ไม่ใช่เดือนที่กำลังเปิดดูอยู่
    // (เดิมใช้ payload.row ของเดือนที่ดูอยู่ ทำให้บันทึกเดือน 7 ไปลงแถวเดือน 6)
    var startRow = hr + 1;
    var lastRow = sheet.getLastRow();
    var targetYM = ymOf_(payload.date);
    var targetRow = 0;

    var block = (lastRow >= startRow)
      ? sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getValues()
      : [];

    if (targetYM) {
      // 1) หาแถวที่ "เดือนของแถว" ตรงกับเดือนที่กรอก
      for (var j = 0; j < block.length; j++) {
        if (rowYM_(block[j], map) === targetYM) { targetRow = startRow + j; break; }
      }
    }
    if (!targetRow && payload.row && Number(payload.row) > hr) {
      // 2) ใช้แถวที่ส่งมา เฉพาะเมื่อไม่ได้กรอกวันที่ (แก้ไขข้อมูลอื่นของแถวนั้น)
      if (!targetYM) targetRow = Number(payload.row);
    }
    if (!targetRow && installment) {
      // 3) จับคู่ตามชื่องวด เฉพาะแถวที่ยังไม่มีเดือนกำกับ
      for (var k = 0; k < block.length; k++) {
        if (String(block[k][map.installment]).replace(/\s+/g, ' ').trim() === installment &&
            !rowYM_(block[k], map)) { targetRow = startRow + k; break; }
      }
    }
    var isNew = !targetRow;
    if (isNew) targetRow = Math.max(sheet.getLastRow() + 1, hr + 1);
    // แถวใหม่: ตั้งเลขงวดถัดไปให้อัตโนมัติ ถ้าไม่ได้ระบุ
    // หรือถ้าชื่องวดที่ส่งมาถูกใช้ไปแล้ว (เช่นค้างมาจากเดือนที่เปิดดูอยู่) กันงวดซ้ำ
    if (isNew) {
      var taken = false;
      if (installment) {
        for (var t = 0; t < block.length; t++) {
          if (String(block[t][map.installment]).replace(/\s+/g, ' ').trim() === installment) { taken = true; break; }
        }
      }
      if (!installment || taken) installment = nextInstallment_(block, map);
    }

    var rowValues = new Array(width).fill('');
    if (!isNew && targetRow <= sheet.getLastRow()) {
      rowValues = sheet.getRange(targetRow, 1, 1, width).getValues()[0];
    }

    // เขียนชื่องวดเฉพาะแถวใหม่ หรือแถวเดิมที่ยังไม่มีชื่องวด
    // (กันชื่องวดของ "เดือนที่กำลังดู" ไปทับงวดของแถวที่จับคู่ได้จริง)
    if (installment && (isNew || !String(rowValues[map.installment] || '').trim())) {
      rowValues[map.installment] = installment;
    }
    if (payload.date) rowValues[map[cat.dateKey]] = String(payload.date);
    if (payload.amount !== '' && payload.amount !== null && payload.amount !== undefined) {
      rowValues[map[cat.amtKey]] = Number(payload.amount);
    }
    var warning = '';
    if (payload.slip && payload.slip.data && cat.slipKey) {
      // หมวดที่ต้องสร้างคอลัมน์สลิปเอง — เขียนได้ต่อเมื่อมีหัวคอลัมน์จริงแล้ว
      // (ถ้าชีตเป็น "ตาราง" ที่เพิ่มคอลัมน์ไม่ได้ จะข้าม ไม่เขียนลงคอลัมน์ผิดที่)
      var needsHeader = AUTO_SLIP_FIELDS.indexOf(cat.slipKey) >= 0;
      if (!needsHeader || hasHeaderFor_(sheet, hr, cat.slipKey)) {
        var vals = {}; vals[cat.dateKey] = payload.date || '';
        rowValues[map[cat.slipKey]] = uploadFileToDrive_(payload.slip, cat.slipKey, vals);
      } else {
        warning = 'บันทึกข้อมูลแล้ว แต่ยังเก็บลิงก์สลิปไม่ได้ — ชีตไม่ยอมให้เพิ่มคอลัมน์ใหม่ ' +
                  'กรุณาเพิ่มคอลัมน์ชื่อ "' + slipHeaderOf_(cat.slipKey) + '" ในชีตก่อน';
      }
    }

    sheet.getRange(targetRow, 1, 1, width).setValues([rowValues]);

    return {
      ok: true, row: targetRow, isNew: isNew,
      installment: String(rowValues[map.installment] || ''),
      monthLabel: thaiMonthLabel_(payload.date, ''),
      warning: warning
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

/** รายชื่อหมวด (ให้หน้าเว็บใช้สร้างฟอร์ม/ประวัติ/สรุป) */
function getCategories() {
  if (!isAllowed_()) return [];
  return CATEGORIES.map(function (c) {
    return {
      key: c.key, name: c.name, dest: c.dest, color: c.color,
      income: !!c.income, hasSlip: !!c.slipKey, slipOptional: !!c.slipOptional,
      fixed: !!c.fixed, defaultAmount: c.defaultAmount || 0, planAmount: c.planAmount || 0,
      startYM: c.startYM || '', amtKey: c.amtKey, dateKey: c.dateKey, slipKey: c.slipKey
    };
  });
}

/**
 * เลขงวดของเดือนหนึ่ง — ให้ระบบเติมให้อัตโนมัติ
 *   - ถ้ามีแถวของเดือนนั้นแล้ว   -> ใช้งวดเดิมของแถวนั้น
 *   - ถ้ายังไม่มี (เดือนใหม่)     -> เลขงวดถัดไปจากที่มากสุด
 * @param {string} dateStr วันที่ dd/MM/yyyy (หรือ yyyy-mm)
 * @return {Object} { installment, isNew, monthLabel }
 */
function getInstallmentFor(dateStr) {
  if (!isAllowed_()) return { installment: '', isNew: false, monthLabel: '' };
  var ym = '';
  var s = String(dateStr || '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) ym = s;
  else ym = ymOf_(s);
  if (!ym) return { installment: '', isNew: false, monthLabel: '' };

  var recs = getRecords();
  var max = 0, found = '';
  recs.forEach(function (r) {
    var rym = ymOf_(r.rentDate) || ymOf_(r.commonDate) || ymOf_(r.extraDate) || '';
    var m = String(r.installment || '').match(/(\d+)/);
    if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
    if (rym === ym && !found && r.installment) found = String(r.installment);
  });

  var label = thaiMonthLabel_('01/' + ym.split('-')[1] + '/' + ym.split('-')[0], '');
  if (found) return { installment: found, isNew: false, monthLabel: label };
  return { installment: 'งวดที่ ' + (max + 1), isNew: true, monthLabel: label };
}

/** =========================================================================
 *  โอนรวบหลายเดือน (สำหรับหมวดที่กันเงินไว้ทุกเดือนแล้วโอนทีเดียว)
 *  ========================================================================= */

function catByKey_(key) {
  for (var i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].key === key) return CATEGORIES[i]; }
  return null;
}

/**
 * เดือนที่ "กันเงินไว้แล้วแต่ยังไม่ได้โอน" ของหมวดหนึ่ง
 * ใช้แสดงยอดค้างสะสม และให้เลือกโอนรวบทีเดียว
 * @return {Object} { catKey, name, planAmount, months: [{ym,label,amount,row,recorded}], pendingTotal }
 */
function getPendingMonths(categoryKey) {
  if (!isAllowed_()) return { months: [], pendingTotal: 0 };
  var cat = catByKey_(categoryKey);
  if (!cat || cat.fixed || cat.income) return { months: [], pendingTotal: 0 };

  var recs = getRecords();          // ใหม่สุดอยู่บน
  var months = [], total = 0;

  recs.forEach(function (r) {
    var ym = ymOf_(r.rentDate) || ymOf_(r.commonDate) || ymOf_(r.extraDate) || '';
    if (!ym) return;
    var amt = toNumber_(r[cat.amtKey]);
    var date = r[cat.dateKey] || '';
    if (date && /\d/.test(String(date))) return;            // โอนแล้ว ข้าม
    var plan = amt > 0 ? amt : (cat.planAmount || 0);        // ถ้ามียอดไว้แล้วใช้ยอดนั้น
    if (plan <= 0) return;
    months.push({
      ym: ym,
      label: thaiMonthLabel_('01/' + ym.split('-')[1] + '/' + ym.split('-')[0], ''),
      amount: plan,
      row: r.row,
      installment: r.installment || '',
      recorded: amt > 0                                       // มียอดในชีตแล้ว แต่ยังไม่มีวันที่โอน
    });
    total += plan;
  });

  months.sort(function (a, b) { return a.ym < b.ym ? -1 : (a.ym > b.ym ? 1 : 0); });   // เก่า -> ใหม่
  return {
    catKey: cat.key, name: cat.name, dest: cat.dest,
    planAmount: cat.planAmount || 0, months: months, pendingTotal: total
  };
}

/**
 * บันทึกการโอนรวบหลายเดือนในครั้งเดียว
 * เขียนยอด/วันที่โอน/ลิงก์สลิปเดียวกันลงทุกเดือนที่เลือก (ยอดรวมยังถูกต้องรายเดือน)
 * @param {Object} payload { category, months:[{ym, amount}], date:'dd/MM/yyyy', slip? }
 */
function saveBatchAllocation(payload) {
  try {
    return saveBatchAllocation_(payload);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function saveBatchAllocation_(payload) {
  if (!isAllowed_()) return { ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล' };
  var cat = catByKey_(payload && payload.category);
  if (!cat || cat.fixed || cat.income) return { ok: false, error: 'หมวดไม่ถูกต้อง' };

  var picked = (payload.months || []).filter(function (m) { return m && m.ym; });
  if (!picked.length) return { ok: false, error: 'ยังไม่ได้เลือกเดือนที่จะโอน' };
  if (!payload.date) return { ok: false, error: 'กรุณาระบุวันที่โอน' };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_();
    var hr = headerRow_(sheet);
    if (payload.slip && payload.slip.data) ensureSlipHeaders_(sheet, hr);
    var map = getColumnMap_(sheet);
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
    var startRow = hr + 1;
    var lastRow = sheet.getLastRow();
    var block = (lastRow >= startRow)
      ? sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getValues()
      : [];

    // อัปโหลดสลิปครั้งเดียว ใช้ลิงก์เดียวกันทุกเดือนที่เลือก
    var slipUrl = '';
    var warning = '';
    if (payload.slip && payload.slip.data && cat.slipKey) {
      var needsHeader = AUTO_SLIP_FIELDS.indexOf(cat.slipKey) >= 0;
      if (!needsHeader || hasHeaderFor_(sheet, hr, cat.slipKey)) {
        var vals = {}; vals[cat.dateKey] = payload.date;
        slipUrl = uploadFileToDrive_(payload.slip, cat.slipKey, vals);
      } else {
        warning = 'บันทึกแล้ว แต่เก็บลิงก์สลิปไม่ได้ — กรุณาเพิ่มคอลัมน์ "' + slipHeaderOf_(cat.slipKey) + '" ในชีตก่อน';
      }
    }

    var done = [], skipped = [], totalAmount = 0;
    picked.forEach(function (m) {
      var idx = -1;
      for (var j = 0; j < block.length; j++) {
        if (rowYM_(block[j], map) === m.ym) { idx = j; break; }
      }
      if (idx < 0) { skipped.push(m.ym); return; }           // ไม่พบแถวของเดือนนั้น

      var rowValues = block[idx].slice();
      var amount = Number(m.amount);
      if (!(amount > 0)) amount = cat.planAmount || 0;
      rowValues[map[cat.amtKey]] = amount;
      rowValues[map[cat.dateKey]] = String(payload.date);
      if (slipUrl) rowValues[map[cat.slipKey]] = slipUrl;

      sheet.getRange(startRow + idx, 1, 1, width).setValues([rowValues]);
      block[idx] = rowValues;
      done.push(m.ym);
      totalAmount += amount;
    });

    return {
      ok: true, count: done.length, months: done, skipped: skipped,
      total: totalAmount, date: payload.date, hasSlip: !!slipUrl, warning: warning
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * สรุปรายเดือน — เรียงทุกเดือนจากเก่าไปใหม่ เพื่อตรวจสอบง่าย
 * แต่ละเดือนบอก: รับเข้า / จัดสรรออกแยกหมวด / รวมออก / คงเหลือ
 * และตั้งธง dup=true ถ้าเดือนนั้นมีมากกว่า 1 แถว (ข้อมูลซ้ำ)
 */
function getMonthlySummary() {
  if (!isAllowed_()) return { months: [], totals: {} };
  var recs = getRecords();                 // ใหม่สุดอยู่บน
  var byYM = {}, order = [];

  recs.forEach(function (r) {
    var ym = ymOf_(r.rentDate) || ymOf_(r.commonDate) || ymOf_(r.extraDate) || '';
    var key = ym || ('row-' + r.row);
    if (!byYM[key]) { byYM[key] = { ym: ym, rows: [], count: 0 }; order.push(key); }
    byYM[key].rows.push(r);
    byYM[key].count++;
  });

  var months = order.map(function (key) {
    var g = byYM[key];
    var m = {
      ym: g.ym,
      label: g.ym ? thaiMonthLabel_('01/' + g.ym.split('-')[1] + '/' + g.ym.split('-')[0], '') : '(ไม่มีวันที่)',
      installment: '', income: 0, incomeDate: '', incomeSlip: '',
      out: 0, dup: g.count > 1, rowCount: g.count,
      rows: [], cats: {}, dates: {}, slips: {}, mainRow: 0
    };
    g.rows.forEach(function (r) {
      if (!m.installment && r.installment) m.installment = r.installment;
      if (!m.mainRow) m.mainRow = r.row;
      if (!m.incomeDate && r.rentDate) m.incomeDate = r.rentDate;
      if (!m.incomeSlip && r.rentSlip) m.incomeSlip = r.rentSlip;
      m.rows.push(r.row);
      m.income += toNumber_(r.rentAmount);
      CATEGORIES.forEach(function (c) {
        if (c.income) return;
        var amt = c.fixed ? 0 : toNumber_(r[c.amtKey]);   // fixed คิดรวมด้านล่าง
        if (!m.cats[c.key]) m.cats[c.key] = 0;
        m.cats[c.key] += amt;
        if (c.fixed) return;
        if (!m.dates[c.key] && r[c.dateKey]) m.dates[c.key] = r[c.dateKey];       // วันที่โอน
        if (c.slipKey && !m.slips[c.key] && r[c.slipKey]) m.slips[c.key] = r[c.slipKey];
      });
    });
    // หมวดคงที่ (ค่าผ่อนบ้าน) — นับ 1 ครั้งต่อเดือน ถ้าเดือนนั้น >= startYM
    CATEGORIES.forEach(function (c) {
      if (!c.fixed) return;
      var on = !c.startYM || (m.ym && m.ym >= c.startYM);
      m.cats[c.key] = on ? (c.defaultAmount || 0) : 0;
    });
    Object.keys(m.cats).forEach(function (k) { m.out += m.cats[k]; });
    m.leftover = m.income - m.out;
    return m;
  });

  months.sort(function (a, b) { return a.ym < b.ym ? -1 : (a.ym > b.ym ? 1 : 0); });  // เก่า -> ใหม่

  var totals = { income: 0, out: 0, cats: {}, monthCount: months.length, dupCount: 0 };
  months.forEach(function (m) {
    totals.income += m.income; totals.out += m.out;
    if (m.dup) totals.dupCount++;
    Object.keys(m.cats).forEach(function (k) { totals.cats[k] = (totals.cats[k] || 0) + m.cats[k]; });
  });
  totals.leftover = totals.income - totals.out;

  return { months: months, totals: totals };
}

/** =========================================================================
 *  เครื่องมือล้างแถวซ้ำ (รันครั้งเดียวจาก Apps Script editor)
 *  ========================================================================= */

/**
 * อ่านแท็บที่ตั้งไว้ (Database) แล้วเก็บ "งวดละ 1 แถว" โดยใช้ วันที่จ่ายค่าเช่า เป็นตัวจับซ้ำ
 * เลือกแถวที่มีข้อมูลครบที่สุดของแต่ละวันที่ แล้วเขียนผลลงแท็บใหม่ "Database (ไม่ซ้ำ)"
 * ปลอดภัย: ไม่ลบ/ไม่แก้ข้อมูลเดิม — ให้เปิดแท็บใหม่ตรวจก่อน
 * วิธีใช้: ใน Apps Script เลือกฟังก์ชัน dedupeToNewTab แล้วกด Run (ครั้งเดียว)
 */
function dedupeToNewTab() {
  var sheet = getSheet_();
  var hr = headerRow_(sheet);
  var map = getColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
  if (lastRow <= hr) return 'ไม่มีข้อมูลให้ล้าง';

  var headerVals = sheet.getRange(hr, 1, 1, width).getValues()[0];
  var rows = sheet.getRange(hr + 1, 1, lastRow - hr, width).getValues();

  var best = {}, order = [];
  rows.forEach(function (row) {
    var rd = row[map.rentDate];
    var key = (rd instanceof Date)
      ? Utilities.formatDate(rd, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : String(rd == null ? '' : rd).trim();
    if (!key || !/\d/.test(key)) return;   // ข้ามแถวที่ไม่มีวันที่จ่ายค่าเช่า
    var score = row.filter(function (c) { return String(c).trim() !== ''; }).length;
    if (!best[key]) { order.push(key); best[key] = { score: -1, row: row }; }
    if (score > best[key].score) best[key] = { score: score, row: row };
  });

  var out = order.map(function (k) { return best[k].row; });
  out.sort(function (a, b) { return dateSortKey_(a[map.rentDate]) - dateSortKey_(b[map.rentDate]); });

  var ss = sheet.getParent();
  var name = 'Database (ไม่ซ้ำ)';
  var ex = ss.getSheetByName(name);
  if (ex) ss.deleteSheet(ex);
  var nt = ss.insertSheet(name);
  nt.getRange(1, 1, 1, width).setValues([headerVals]);
  if (out.length) nt.getRange(2, 1, out.length, width).setValues(out);

  var msg = 'สร้างแท็บ "' + name + '" แล้ว — เหลือ ' + out.length + ' งวด (จากเดิม ' + rows.length + ' แถว)';
  Logger.log(msg);
  return msg;
}

function dateSortKey_(v) {
  if (v instanceof Date) return v.getTime();
  var p = parseThaiDate_(String(v));
  return p ? new Date(p.y, p.m - 1, p.d).getTime() : 0;
}
