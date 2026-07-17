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

// ชื่อชีต (แท็บ) ที่จะบันทึกข้อมูล ถ้าไม่พบจะใช้ชีตแรกของไฟล์
var SHEET_NAME = 'ข้อมูลหลัก';

// แถวที่เป็นหัวตาราง (เริ่มนับจาก 1)
var HEADER_ROW = 2;

// โฟลเดอร์ใน Google Drive สำหรับเก็บรูปสลิป
//   - ถ้าใส่ ID โฟลเดอร์ไว้ จะอัปโหลดเข้าโฟลเดอร์นั้น
//   - ถ้าเว้นว่าง จะสร้าง/ใช้โฟลเดอร์ชื่อ SLIP_FOLDER_NAME ใน Drive ของคุณอัตโนมัติ
var DRIVE_FOLDER_ID = '';
var SLIP_FOLDER_NAME = 'Rent-home Slips';

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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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
      // ข้ามแถวว่าง
      var hasData = row.some(function (c) { return String(c).trim() !== ''; });
      if (!hasData) return;

      var rec = { row: startRow + i };
      FIELDS.forEach(function (f) {
        var v = row[map[f.key]];
        rec[f.key] = formatCellForClient_(v, f.type);
      });
      records.push(rec);
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
          rowValues[col] = uploadFileToDrive_(raw, f.key);
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
 * @param {Object} fileObj {name, mimeType, data(base64 ไม่รวม prefix)}
 * @param {string} keyPrefix ใช้ตั้งชื่อไฟล์
 */
function uploadFileToDrive_(fileObj, keyPrefix) {
  var folder = getSlipFolder_();
  var bytes = Utilities.base64Decode(fileObj.data);
  var safeName = buildFileName_(fileObj.name, keyPrefix);
  var blob = Utilities.newBlob(bytes, fileObj.mimeType || 'application/octet-stream', safeName);
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // บางองค์กรปิดการแชร์แบบ anyone-with-link ไว้ — ปล่อยผ่าน ไฟล์ยังถูกบันทึก
  }
  return file.getUrl();
}

function buildFileName_(original, keyPrefix) {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
  var ext = '';
  if (original && original.indexOf('.') >= 0) {
    ext = original.substring(original.lastIndexOf('.'));
  }
  return (keyPrefix || 'slip') + '_' + stamp + ext;
}
