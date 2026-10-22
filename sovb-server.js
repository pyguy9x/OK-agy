/**
 * Sovb Server - Quét dòng cuối mỗi sheet trong "So VB di 2025-2030.xlsm"
 * - Mỗi phút quét 1 lần, chỉ push bản ghi MỚI lên Firestore khi sheet có thay đổi
 * - Serve dashboard realtime tại http://localhost:3080
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const ExcelJS = require("exceljs");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const FIREBASE_CREDS_PATH = path.join(__dirname, "firebase-credentials.json");
const HTML_PATH = path.join(__dirname, "dashboard-sovb.html");
const PORT = process.env.PORT || 3080;
const COLLECTION = "so_vb_di";
const SCAN_INTERVAL = 60_000; // 1 phút

// Tự tìm file Excel: env SOVB_XLSM → thư mục script → thư mục hiện tại → các thư mục chuẩn (hỗ trợ tên có dấu tiếng Việt)
function findXlsm() {
  const dirs = [__dirname, process.cwd(), "D:\\Sổ CV đi", "D:\\Minhbe"];
  const cands = [process.env.SOVB_XLSM];
  for (const d of dirs) {
    try {
      cands.push(path.join(d, "So VB di 2025-2030.xlsm"));
      for (const f of fs.readdirSync(d)) {
        if (/^so vb di.*\.xlsm$/i.test(f)) cands.push(path.join(d, f));
      }
    } catch { /* thư mục không tồn tại / không đọc được → bỏ qua */ }
  }
  for (const c of cands.filter(Boolean)) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Không tìm thấy file "So VB di*.xlsm"\n` +
    `→ Đặt file Excel vào cùng thư mục với sovb-server.js, hoặc set env SOVB_XLSM="đường dẫn file"`
  );
}
const XLSM_PATH = findXlsm();

const serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_CREDS_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
console.log(`✅ Firebase OK (${serviceAccount.project_id})`);

const lastSnapshot = new Map(); // tenSheet -> chuỗi hash nội dung lần quét trước

// Sheet phụ trợ không có dữ liệu văn bản
const SKIP_SHEETS = new Set(["Kangatang"]);

// ---------- Trích xuất ----------
function fmtCell(v) {
  if (v == null) return "";
  if (typeof v === "object" && v instanceof Date) {
    const d = v;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return String(v).trim();
}

function extractLastRows() {
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.readFile(XLSM_PATH).then(() => {
    const results = [];
    for (const ws of wb.worksheets) {
      if (SKIP_SHEETS.has(ws.name)) continue;
      let last = null;
      let lastRowNum = 0;
      ws.eachRow((row, num) => {
        // Chỉ tính cột A..I (1-9), bỏ cột J (ghi chú định dạng kiểu "Hường BXDD")
        const hasData =
          row.values &&
          row.values.slice(1, 10).some((v) => v != null && String(v).trim() !== "");
        if (hasData) {
          lastRowNum = num;
          last = row;
        }
      });
      if (!last) continue;

      const c = last.values || [];
      const item = {
        tenSheet: ws.name,
        row: lastRowNum,
        thoiGian: fmtCell(c[1]),
        soKH: fmtCell(c[2]),
        noiDung: fmtCell(c[3]),
        ky: fmtCell(c[4]),
        gui: fmtCell(c[10]),
      };
      results.push(item);
    }
    return results;
  });
}

// ---------- Push Firestore (chỉ khi thay đổi) ----------
function pushChanged(items) {
  const charTrang = [];
  for (const it of items) {
    const sig = JSON.stringify([it.thoiGian, it.soKH, it.noiDung, it.ky, it.gui]);
    const prev = lastSnapshot.get(it.tenSheet);
    if (prev === sig) continue; // không đổi → bỏ qua
    lastSnapshot.set(it.tenSheet, sig);
    charTrang.push(it);

    db.collection(COLLECTION)
      .add({ ...it, thoiGianQuet: new Date().toISOString() })
      .then((ref) => console.log(`   ↥ [${it.tenSheet}] doc ${ref.id}: ${it.soKH}`))
      .catch((e) => console.error(`   ✗ [${it.tenSheet}] lỗi Firestore: ${e.message}`));
  }
  return charTrang;
}

// ---------- Quy trình quét ----------
let latest = []; // dữ liệu mới nhất để dashboard load lần đầu

async function scan(reason = "") {
  try {
    const t = new Date().toLocaleTimeString("vi-VN");
    const items = await extractLastRows();
    latest = items;
    const changed = pushChanged(items);
    console.log(
      `⏰ ${t} quét${reason} — ${items.length} sheet, ${changed.length} sheet có thay đổi`
    );
    if (changed.length) broadcast();
  } catch (e) {
    console.error(`✗ Lỗi quét${reason}:`, e.message);
  }
}

// ---------- HTTP + SSE (dashboard realtime) ----------
const sseClients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: "update", items: latest, at: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.url === "/api/latest") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ items: latest, at: new Date().toISOString() }));
  }
  if (req.url === "/api/stream") {
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", items: latest })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.url === "/" || req.url === "/dashboard") {
    try {
      return res.end(fs.readFileSync(HTML_PATH));
    } catch {
      res.writeHead(404);
      return res.end("Thiếu file dashboard-sovb.html");
    }
  }
  res.writeHead(404);
  res.end("Not found");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} đang bị chiếm — có thể sovb-server đang chạy sẵn. Đổi PORT=xxxx hoặc tắt bản cũ.`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`🖥️ Dashboard: http://localhost:${PORT}`);
  console.log(`⏳ Quét mỗi ${SCAN_INTERVAL / 1000}s — file: ${path.basename(XLSM_PATH)}`);
});

// ---------- Seed snapshot từ Firestore (tránh push trùng khi restart) ----------
async function seedFromFirestore() {
  try {
    const snap = await db.collection(COLLECTION).limit(1000).get();
    const newest = new Map(); // tenSheet -> doc có thoiGianQuet mới nhất
    snap.forEach((doc) => {
      const d = doc.data();
      if (!d || !d.tenSheet || !d.soKH && !d.noiDung) return;
      const cur = newest.get(d.tenSheet);
      if (!cur || String(d.thoiGianQuet) > String(cur.thoiGianQuet)) newest.set(d.tenSheet, d);
    });
    const items = [];
    for (const [tenSheet, d] of newest) {
      items.push({
        tenSheet, row: d.row, thoiGian: d.thoiGian, soKH: d.soKH,
        noiDung: d.noiDung, ky: d.ky, gui: d.gui,
      });
      lastSnapshot.set(tenSheet, JSON.stringify([d.thoiGian, d.soKH, d.noiDung, d.ky, d.gui]));
    }
    if (items.length) {
      latest = items;
      console.log(`♻️ Seed ${items.length} sheet từ Firestore — restart sẽ không gây push trùng`);
    }
  } catch (e) {
    console.error(`✗ Seed Firestore lỗi: ${e.message}`);
  }
}

// ---------- Chạy ----------
(async () => {
  await seedFromFirestore();
  await scan(" (lần đầu)");
})();
setInterval(() => scan(), SCAN_INTERVAL);
