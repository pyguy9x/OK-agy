// day-du-lieu-len-firebase.js
// Doc file XLSX tien do nop dang phi trong cung thu muc -> ghi Firestore dangphi/current
// Giu nguyen title/orgName/provRank cua doc cu (neu co), chi thay units + updateDate + lastModified.
// Cach chay: node day-du-lieu-len-firebase.js
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const dir = __dirname;

function cellVal(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v.result !== undefined ? v.result : (v.text || null);
  return v;
}
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function sums(units) {
  const s = { n: units.length, total_dv: 0, approved_paid: 0, approved_unpaid: 0, not_declared: 0, pending_review: 0, exempt: 0, total_amount: 0 };
  for (const u of units) {
    s.total_dv += u.total_dv || 0;
    s.approved_paid += u.approved_paid || 0;
    s.approved_unpaid += u.approved_unpaid || 0;
    s.not_declared += u.not_declared || 0;
    s.pending_review += u.pending_review || 0;
    s.exempt += u.exempt || 0;
    s.total_amount += u.amount || 0;
  }
  return s;
}

(async () => {
  const log = [];
  // --- Parse XLSX ---
  const xlsx = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.xlsx'));
  if (!xlsx) { console.error('LOI: khong thay file xlsx'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, xlsx));
  const ws = wb.worksheets[0];

  // updateDate tu dong tieu de (vd "( Cap nhat 20h ngay 20/10/2026)") -> "20h ngay 20/10/2026"
  let updateDate = '';
  for (let r = 1; r <= 4 && !updateDate; r++) {
    const t = String(cellVal(ws.getRow(r).getCell(1)) || '');
    const m = t.match(/(\d{1,2}h\s*ng[àa]y\s*\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (m) updateDate = m[1].replace(/\s+/g, ' ');
  }
  log.push('updateDate trich tu xlsx: ' + (updateDate || '(khong tim thay)'));

  const units = [];
  let group = '';
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const c1 = cellVal(row.getCell(1));
    const c2 = cellVal(row.getCell(2));
    const c3 = cellVal(row.getCell(3));
    // Dong tieu de nhom: cot1 la so La Ma, cot2 co chu, cot3 rong
    if (typeof c1 === 'string' && /^[IVX]{1,4}$/.test(c1.trim()) && c2 && (c3 === null || c3 === '')) {
      group = String(c2).trim();
      continue;
    }
    // Dong du lieu: cot1 la so STT
    if (typeof c1 === 'number' && c2) {
      units.push({
        stt: c1,
        group,
        name: String(c2).trim(),
        total_dv: num(c3),
        exempt: num(cellVal(row.getCell(4))),
        pending_review: num(cellVal(row.getCell(5))),
        approved_unpaid: num(cellVal(row.getCell(6))),
        approved_paid: num(cellVal(row.getCell(7))),
        not_declared: num(cellVal(row.getCell(8))),
        rate: num(cellVal(row.getCell(9))),
        amount: Math.round(num(cellVal(row.getCell(10))) * 1000),
      });
    }
  }
  log.push('XLSX parse: ' + JSON.stringify(sums(units)));
  const ej = JSON.parse(fs.readFileSync(path.join(dir, 'extracted_data.json'), 'utf8'));
  log.push('extracted_data.json: ' + JSON.stringify(sums(ej)));
  if (units.length === 0) { console.error('LOI: parse duoc 0 don vi'); process.exit(1); }

  // --- Firebase ---
  const sa = require('./firebase-credentials.json');
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();
  const ref = db.collection('dangphi').doc('current');
  const cur = await ref.get();
  const old = cur.exists ? cur.data() : {};
  if (cur.exists) {
    log.push('Doc cu: units=' + (old.units || []).length + ' | sums=' + JSON.stringify(sums(old.units || [])));
    log.push('Doc cu keys unit[0]: ' + (old.units && old.units[0] ? Object.keys(old.units[0]).join(',') : '(khong co)'));
  } else {
    log.push('Doc cu: chua ton tai, se tao moi');
  }

  const payload = {
    units,
    updateDate: updateDate || old.updateDate || '',
    title: old.title || 'TIẾN ĐỘ TRIỂN KHAI NỘP ĐẢNG PHÍ TRÊN DỊCH VỤ CÔNG',
    orgName: old.orgName || '',
    provRank: old.provRank || '45/103',
    lastModified: FieldValue.serverTimestamp(),
  };
  await ref.set(payload);
  log.push('DA GHI dangphi/current: ' + units.length + ' don vi');

  // --- Verify: doc lai ---
  const back = await ref.get();
  const d = back.data();
  log.push('VERIFY doc sau ghi: units=' + (d.units || []).length + ' | sums=' + JSON.stringify(sums(d.units || [])));
  log.push('VERIFY updateDate=' + d.updateDate + ' | provRank=' + d.provRank);
  log.push('VERIFY unit[0]=' + JSON.stringify((d.units || [])[0]));
  log.push('VERIFY unit cuoi=' + JSON.stringify((d.units || [])[d.units.length - 1]));
  const top3 = [...(d.units || [])].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 3);
  top3.forEach((u, i) => log.push('TOP' + (i + 1) + ': ' + u.name + ' = ' + (u.amount || 0)));

  fs.writeFileSync(path.join(dir, 'push-result.txt'), log.join('\n'), 'utf8');
  console.log('PUSH OK - xem push-result.txt');
  process.exit(0);
})().catch(e => { console.error('LOI:', e.message); process.exit(1); });
