const fs = require("fs");
const path = require("path");
const http = require("http");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PORT = process.env.PORT || 3000;
const COLLECTION = "van_ban";
const LIMIT = 1000;
const DELETE_COUNT = 300; // so tin cu nhat bi xoá khi chạm limit
const CLEANUP_COOLDOWN_MS = 15000; // tránh xoá liên tục trong lúc dồn dập tin nhắn
let autoCleanup = true; // bật/tắt tự dọn khi chạm limit (reset về BẬT sau khi restart)

const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, "firebase-credentials.json"), "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const clients = new Set();
let latest = { docs: [], total: 0 };

function docToObj(doc) {
  const d = doc.data();
  let createdAt = d.created_at;
  if (createdAt && typeof createdAt.toDate === "function") createdAt = createdAt.toDate().toISOString();
  else if (createdAt && createdAt._seconds) createdAt = new Date(createdAt._seconds * 1000).toISOString();
  else createdAt = null;
  delete d.created_at;
  return { id: doc.id, created_at: createdAt, ...d };
}

function emit(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(line);
}

let firstSnapshot = true;

// --- Tự động dọn dẹp: khi tổng tin nhắn chạm LIMIT thì xoá DELETE_COUNT tin cũ nhất trên Firestore ---
let cleaning = false;
let lastCleanupAt = 0;

async function cleanupOldest(reason) {
  const now = Date.now();
  if (cleaning || now - lastCleanupAt < CLEANUP_COOLDOWN_MS) return null;
  lastCleanupAt = now;
  cleaning = true;
  try {
    const snap = await db
      .collection(COLLECTION)
      .orderBy("created_at", "asc")
      .limit(DELETE_COUNT)
      .get();
    if (snap.empty) return { ok: true, deleted: 0 };
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`🧹 ${reason === "auto" ? "Chạm limit " + LIMIT + " — tự động" : "Thủ công"} xoá ${snap.size} tin cũ nhất trên Firestore`);
    emit({ type: "cleanup", deleted: snap.size, reason });
    return { ok: true, deleted: snap.size };
  } catch (e) {
    console.error("❌ Dọn dẹp Firestore:", e.message);
    return { ok: false, error: e.message };
  } finally {
    cleaning = false;
  }
}

db.collection(COLLECTION)
  .orderBy("created_at", "desc")
  .limit(LIMIT)
  .onSnapshot(
    (snap) => {
      latest = { docs: snap.docs.map(docToObj), total: snap.size };
      if (autoCleanup && snap.size >= LIMIT) cleanupOldest("auto");
      if (firstSnapshot) {
        firstSnapshot = false;
        emit({ type: "init", total: snap.size, docs: latest.docs });
        return;
      }
      const added = [];
      const modified = [];
      for (const change of snap.docChanges()) {
        const obj = docToObj(change.doc);
        if (change.type === "added") added.push(obj);
        else if (change.type === "modified") modified.push(obj);
      }
      if (added.length || modified.length) emit({ type: "delta", total: snap.size, added, modified });
    },
    (e) => console.error("❌ Firestore snapshot:", e.message)
  );

const HTML_PATH = path.join(__dirname, "dashboard.html");
const SKIP_FILE = path.join(__dirname, "bo_qua_nhom.txt");
const IMPORTANT_FILE = path.join(__dirname, "nhom_quan_trong.txt");
const DONE_FILE = path.join(__dirname, "tin_da_xong.txt");

function readIdFile(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/\D/g, ""))
    .filter(Boolean);
}

// Giữ nguyên id đầy đủ (Firestore id có cả chữ cái)
function readRawIdFile(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function writeRawIdFile(file, ids) {
  fs.writeFileSync(file, ids.length ? ids.join("\n") + "\n" : "", "utf8");
}

function writeIdFile(file, ids) {
  fs.writeFileSync(file, ids.length ? ids.join("\n") + "\n" : "", "utf8");
}

function appendSkipId(id) {
  const current = fs.existsSync(SKIP_FILE) ? fs.readFileSync(SKIP_FILE, "utf8") : "";
  if (current.split(/\r?\n/).some((l) => l.replace(/\D/g, "") === id)) return false;
  fs.appendFileSync(SKIP_FILE, (current.length && !current.endsWith("\n") ? "\n" : "") + id + "\n", "utf8");
  return true;
}

// Bỏ một nhóm khỏi danh sách bỏ qua (hiện lại trên dashboard)
function removeSkipId(id) {
  if (!fs.existsSync(SKIP_FILE)) return { removed: false };
  const list = readIdFile(SKIP_FILE);
  const updated = list.filter((x) => x !== id);
  const removed = updated.length !== list.length;
  if (removed) writeRawIdFile(SKIP_FILE, updated);
  return { removed };
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/") {
    fs.readFile(HTML_PATH, (err, buf) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Thieu dashboard.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
    return;
  }

  if (url === "/nolimit") {
    fs.readFile(path.join(__dirname, "dashboard-nolimit.html"), (err, buf) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Thieu dashboard-nolimit.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
    return;
  }

  if (url === "/cleanup" && req.method === "POST") {
    cleanupOldest("manual").then((r) => {
      if (!r) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, busy: true }));
        return;
      }
      res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
      // total trong `latest` chua kip cap nhat sau khi xoá nên tự trừ đi
      res.end(JSON.stringify({ ...r, remaining: Math.max(0, latest.total - (r.deleted || 0)) }));
    });
    return;
  }

  if (url === "/cleanup-auto") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, on: autoCleanup }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { on } = JSON.parse(body || "{}");
          autoCleanup = !!on;
          console.log(`🧹 Tự dọn khi chạm limit: ${autoCleanup ? "BẬT" : "TẮT"}`);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, on: autoCleanup }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  if (url === "/skip" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { threadId, remove } = JSON.parse(body || "{}");
        const id = String(threadId || "").replace(/\D/g, "");
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Thieu threadId" }));
          return;
        }
        if (remove) {
          const r = removeSkipId(id);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, ...r, id }));
          return;
        }
        const added = appendSkipId(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, added, id }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify({ type: "init", total: latest.total, docs: latest.docs })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url === "/important") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ids: readIdFile(IMPORTANT_FILE) }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { threadId, important } = JSON.parse(body || "{}");
          const id = String(threadId || "").replace(/\D/g, "");
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Thieu threadId" }));
            return;
          }
          const set = new Set(readIdFile(IMPORTANT_FILE));
          if (important) set.add(id);
          else set.delete(id);
          writeIdFile(IMPORTANT_FILE, Array.from(set));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, ids: Array.from(set) }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  if (url === "/done") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ids: readRawIdFile(DONE_FILE) }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { id, done } = JSON.parse(body || "{}");
          const docId = String(id || "").trim();
          if (!docId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Thieu id" }));
            return;
          }
          const set = new Set(readRawIdFile(DONE_FILE));
          if (done) set.add(docId);
          else set.delete(docId);
          writeRawIdFile(DONE_FILE, Array.from(set));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, ids: Array.from(set) }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404");
});

server.listen(PORT, () => {
  console.log(`✅ Dashboard realtime: http://localhost:${PORT}`);
});

setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25000);
