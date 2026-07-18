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

// รหัสสเปรดชีต (จาก URL: .../d/<ID>/edit)
//   - จำเป็นสำหรับสคริปต์แบบ standalone ที่ deploy ผ่าน clasp
//   - ถ้าเว้นว่าง จะใช้สเปรดชีตที่ผูกกับสคริปต์ (กรณีติดตั้งผ่าน Extensions → Apps Script)
var SPREADSHEET_ID = 'REDACTED';

// ชื่อชีต (แท็บ) ที่จะบันทึกข้อมูล ถ้าไม่พบจะใช้ชีตแรกของไฟล์
var SHEET_NAME = 'ข้อมูลหลัก';

// แถวที่เป็นหัวตาราง (เริ่มนับจาก 1)
var HEADER_ROW = 2;

// โฟลเดอร์ใน Google Drive สำหรับเก็บรูปสลิป
//   - ตั้งเป็นโฟลเดอร์เดิมที่เก็บสลิปอยู่แล้ว เพื่อให้ไฟล์ใหม่ไปรวมกับของเก่า
//   - ถ้าเว้นว่าง จะสร้าง/ใช้โฟลเดอร์ชื่อ SLIP_FOLDER_NAME ใน Drive ของคุณอัตโนมัติ
var DRIVE_FOLDER_ID = 'REDACTED';
var SLIP_FOLDER_NAME = 'Rent-home Slips';

/**
 * รูปแบบการตั้งชื่อไฟล์สลิป — ให้ตรงกับที่ใช้ใน Google Drive อยู่แล้ว
 *   prefix      : คำนำหน้า (Rent / ส่วนกลาง / Bank)
 *   dateKey     : ใช้ "วันที่จ่าย" ช่องไหนมาตั้งชื่อ
 *   calendar    : 'greg' = ค.ศ.  |  'buddhist' = พ.ศ. (+543)
 *   granularity : 'day' = ปี-เดือน-วัน  |  'month' = ปี-เดือน
 *   suffix      : ต่อท้าย (ถ้ามี)
 * ตัวอย่าง: Rent_2026-07-10.jpg | ส่วนกลาง_2569-07-17.jpg | Bank_2026-07-17.jpg
 *           ส่วนกลาง_2569-05_เปลี่ยนนิติ.jpg
 */
var SLIP_NAMING = {
  rentSlip:     { prefix: 'Rent',     dateKey: 'rentDate',   calendar: 'greg',     granularity: 'day' },
  commonSlip:   { prefix: 'ส่วนกลาง', dateKey: 'commonDate', calendar: 'buddhist', granularity: 'day' },
  extraSlip:    { prefix: 'Bank',     dateKey: 'extraDate',  calendar: 'greg',     granularity: 'day' },
  juristicSlip: { prefix: 'ส่วนกลาง', dateKey: 'commonDate', calendar: 'buddhist', granularity: 'month', suffix: 'เปลี่ยนนิติ' }
};

/**
 * หมวดเงิน (โมเดล "กระแสเงิน" ของดีไซน์ Broadsheet)
 *   income=true คือเงินรับเข้า (ค่าเช่า) — ที่เหลือคือการจัดสรรออก
 *   แต่ละหมวดผูกกับคอลัมน์วันที่/จำนวน/สลิป ในชีตเดิม
 */
var CATEGORIES = [
  { key: 'rent',   name: 'ค่าเช่ารับเข้า',      dest: 'บัญชีเจ้าของบ้าน',   dateKey: 'rentDate',   amtKey: 'rentAmount',   slipKey: 'rentSlip',   income: true, color: 'var(--color-accent-800)' },
  { key: 'extra',  name: 'ผ่อนบ้านเพิ่มเติม',   dest: 'ธนาคาร',             dateKey: 'extraDate',  amtKey: 'extraAmount',  slipKey: 'extraSlip',  color: 'var(--color-accent-700)' },
  { key: 'common', name: 'ค่าส่วนกลาง',         dest: 'นิติบุคคลหมู่บ้าน',   dateKey: 'commonDate', amtKey: 'commonAmount', slipKey: 'commonSlip', color: 'var(--color-accent-500)' },
  { key: 'er',     name: 'เงินสำรองฉุกเฉิน',    dest: 'บัญชีสำรอง (ER)',    dateKey: 'erDate',     amtKey: 'erAmount',     slipKey: null,         color: 'var(--color-accent-400)' },
  { key: 'gold',   name: 'ลงทุนทองคำ',          dest: 'ออมทองคำ',           dateKey: 'goldDate',   amtKey: 'goldAmount',   slipKey: null,         color: 'var(--color-accent-2-600)' },
  { key: 'tax',    name: 'กันภาษี',             dest: 'บัญชีภาษี',          dateKey: 'taxDate',    amtKey: 'taxAmount',    slipKey: null,         color: 'var(--color-accent-2-400)' }
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

  { key: 'installment', header: 'Column 10',              defaultCol: 10, label: 'งวดที่',       type: 'text',   section: 'info' },

  { key: 'erDate',      header: 'วันที่เก็บ ER',          defaultCol: 11, label: 'วันที่เก็บ',   type: 'date',   section: 'er' },
  { key: 'erAmount',    header: 'Emergency',              defaultCol: 12, label: 'จำนวนเงิน',    type: 'number', section: 'er' },

  { key: 'goldDate',    header: 'วันที่ลงทุน Gold Now',   defaultCol: 13, label: 'วันที่ลงทุน',  type: 'date',   section: 'gold' },
  { key: 'goldAmount',  header: 'Gold now',               defaultCol: 14, label: 'จำนวนเงิน',    type: 'number', section: 'gold' },

  { key: 'taxDate',     header: 'วันที่เตรยมจ่ายภาษี',    defaultCol: 15, label: 'วันที่เตรียมจ่าย', type: 'date', section: 'tax' },
  { key: 'taxAmount',   header: 'เงินจ่ายภาษี',           defaultCol: 16, label: 'จำนวนเงิน',    type: 'number', section: 'tax' }
];

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
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Rent-home | บันทึกค่าใช้จ่ายบ้าน')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico');
}

/** ให้ HTML ไฟล์อื่น include เข้ามาได้ (เช่น CSS/JS) */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** =========================================================================
 *  ตัวช่วยเข้าถึงชีตและคอลัมน์
 *  ========================================================================= */

function getSheet_() {
  var ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.getSheets()[0];
  return sheet;
}

/**
 * สร้างแผนที่ key -> ดัชนีคอลัมน์ (0-based)
 * โดยพยายามจับคู่จากชื่อหัวตารางก่อน ถ้าไม่พบใช้ defaultCol
 */
function getColumnMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
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
  var sheet = getSheet_();
  var map = getColumnMap_(sheet);
  var startRow = HEADER_ROW + 1;
  var lastRow = sheet.getLastRow();
  var records = [];

  if (lastRow >= startRow) {
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
    var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();

    values.forEach(function (row, i) {
      var rec = { row: startRow + i };

      // นับเฉพาะช่องที่แอปใช้จริง — กันแถวที่มีแต่ข้อความอื่น (เช่น "ดูสลิป")
      // ในคอลัมน์ที่ไม่เกี่ยวข้อง มาโผล่เป็นรายการเปล่า ๆ วนซ้ำ
      var hasData = false;
      FIELDS.forEach(function (f) {
        var v = formatCellForClient_(row[map[f.key]], f.type);
        rec[f.key] = v;
        if (String(v).trim() !== '') hasData = true;
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
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // กันการบันทึกพร้อมกันจนข้อมูลชนกัน
  try {
    var sheet = getSheet_();
    var map = getColumnMap_(sheet);
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);

    var isEdit = payload.row && Number(payload.row) > HEADER_ROW;
    var targetRow = isEdit ? Number(payload.row) : sheet.getLastRow() + 1;
    if (targetRow <= HEADER_ROW) targetRow = HEADER_ROW + 1;

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
    applyNumberFormats_(sheet, targetRow, map);

    return { ok: true, row: targetRow, edited: isEdit };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

/** จัดรูปแบบสกุลเงินให้คอลัมน์จำนวนเงินที่เป็นเงินบาท */
function applyNumberFormats_(sheet, row, map) {
  var bahtKeys = ['rentAmount', 'commonAmount', 'extraAmount'];
  bahtKeys.forEach(function (k) {
    if (map[k] != null) {
      sheet.getRange(row, map[k] + 1).setNumberFormat('฿#,##0.00');
    }
  });
}

/** =========================================================================
 *  อัปโหลดรูปเข้า Google Drive
 *  ========================================================================= */

function getSlipFolder_() {
  if (DRIVE_FOLDER_ID) {
    return DriveApp.getFolderById(DRIVE_FOLDER_ID);
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

/** ป้ายเดือน-ปี (พ.ศ.) จากวันที่ dd/MM/yyyy เช่น "ก.ค. 2569" */
function thaiMonthLabel_(dateStr, fallback) {
  var p = parseThaiDate_(dateStr);
  if (!p) return fallback || '';
  return THAI_MONTHS_[p.m - 1] + ' ' + (p.y + 543);
}

/** คำนวณสถานะของการจัดสรรจากข้อมูลที่มีในแถว */
function deriveStatus_(cat, amt, dateStr, slip) {
  var hasAmt = amt > 0;
  var hasDate = !!(dateStr && String(dateStr).trim());
  var hasSlip = slip && /^https?:\/\//.test(String(slip));
  if (!hasAmt && !hasDate && !hasSlip) return 'none';   // ยังไม่ตั้ง/ข้ามเดือนนี้
  if (hasSlip) return 'paid';
  if (cat.slipKey) {                       // หมวดที่ต้องมีสลิป
    return (hasAmt && hasDate) ? 'waiting_slip' : 'waiting_transfer';
  }
  return (hasAmt && hasDate) ? 'paid' : 'waiting_transfer';   // หมวดที่ไม่มีช่องสลิป
}

/**
 * ข้อมูลหน้า "จัดเงิน" (Dashboard) ของเดือนหนึ่ง
 * @param {number} offset 0 = เดือนล่าสุด, 1 = ก่อนหน้า, ...
 */
function getDashboard(offset) {
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
    var amt = toNumber_(r[c.amtKey]);
    var date = r[c.dateKey] || '';
    var slip = c.slipKey ? (r[c.slipKey] || '') : '';
    allocations.push({
      key: c.key, name: c.name, dest: c.dest, color: c.color,
      amount: amt, date: date, slip: slip,
      status: deriveStatus_(c, amt, date, slip)
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
function saveAllocation(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cat = null;
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === payload.category) { cat = CATEGORIES[i]; break; }
    }
    if (!cat) return { ok: false, error: 'หมวดไม่ถูกต้อง' };

    var sheet = getSheet_();
    var map = getColumnMap_(sheet);
    var width = Math.max(sheet.getLastColumn(), maxColumnIndex_(map) + 1);
    var installment = String(payload.installment || '').trim();

    // หาแถวเป้าหมาย: ตาม row -> ตามงวด -> เพิ่มใหม่
    var targetRow = 0;
    if (payload.row && Number(payload.row) > HEADER_ROW) {
      targetRow = Number(payload.row);
    } else if (installment) {
      var startRow = HEADER_ROW + 1;
      var lastRow = sheet.getLastRow();
      if (lastRow >= startRow) {
        var col = map.installment;
        var colVals = sheet.getRange(startRow, col + 1, lastRow - startRow + 1, 1).getValues();
        for (var j = 0; j < colVals.length; j++) {
          if (String(colVals[j][0]).replace(/\s+/g, ' ').trim() === installment) {
            targetRow = startRow + j; break;
          }
        }
      }
    }
    var isNew = !targetRow;
    if (isNew) targetRow = Math.max(sheet.getLastRow() + 1, HEADER_ROW + 1);

    var rowValues = new Array(width).fill('');
    if (!isNew && targetRow <= sheet.getLastRow()) {
      rowValues = sheet.getRange(targetRow, 1, 1, width).getValues()[0];
    }

    if (installment) rowValues[map.installment] = installment;
    if (payload.date) rowValues[map[cat.dateKey]] = String(payload.date);
    if (payload.amount !== '' && payload.amount !== null && payload.amount !== undefined) {
      rowValues[map[cat.amtKey]] = Number(payload.amount);
    }
    if (payload.slip && payload.slip.data && cat.slipKey) {
      var vals = {}; vals[cat.dateKey] = payload.date || '';
      rowValues[map[cat.slipKey]] = uploadFileToDrive_(payload.slip, cat.slipKey, vals);
    }

    sheet.getRange(targetRow, 1, 1, width).setValues([rowValues]);
    applyNumberFormats_(sheet, targetRow, map);

    return { ok: true, row: targetRow, isNew: isNew };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

/** รายชื่อหมวด (ให้หน้าเว็บใช้สร้างฟอร์ม/ประวัติ/สรุป) */
function getCategories() {
  return CATEGORIES.map(function (c) {
    return {
      key: c.key, name: c.name, dest: c.dest, color: c.color,
      income: !!c.income, hasSlip: !!c.slipKey,
      amtKey: c.amtKey, dateKey: c.dateKey, slipKey: c.slipKey
    };
  });
}
