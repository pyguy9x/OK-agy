// Test tạm 2: doc mới nhất trong Firestore + chờ delta dài hơn
const fs = require("fs");
const http = require("http");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

const sa = JSON.parse(fs.readFileSync(__dirname + "/firebase-credentials.json", "utf8"));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

db.collection("van_ban")
  .orderBy("created_at", "desc")
  .limit(3)
  .get()
  .then((snap) => {
    console.log("--- 3 tin mới nhất trên Firestore ---");
    snap.forEach((d) => {
      const v = d.data();
      let t = "?";
      const ca = v.created_at;
      if (ca && ca.toDate) t = ca.toDate().toLocaleString("vi-VN");
      else if (ca && ca._seconds) t = new Date(ca._seconds * 1000).toLocaleString("vi-VN");
      console.log(`[${t}] ${v.threadName || v.threadId} | ${v.nguoi_gui}: ${(v.noi_dung || "").slice(0, 60)}`);
    });
    console.log("Bây giờ:", new Date().toLocaleString("vi-VN"));

    // test delta lần 2, chờ 8s
    return new Promise((resolve, reject) => {
      const req = http.get("http://localhost:3000/events", (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        setTimeout(() => {
          db.collection("van_ban")
            .add({
              loai: "TEST", noi_dung: "[TEST-DELTA-2]", tin_goc: "[TEST-DELTA-2]",
              nguoi_gui: "TestBot", threadId: "0", threadName: "TEST", loai_hoi: "GROUP",
              created_at: FieldValue.serverTimestamp(), gio_gui: new Date().toISOString(),
            })
            .then((r) => {
              setTimeout(() => {
                console.log(buf.includes("[TEST-DELTA-2]") ? "✅ Delta nhận được (chờ 8s)" : "❌ Vẫn không có delta sau 8s — listener onSnapshot đã chết");
                r.delete().then(() => process.exit(0));
              }, 8000);
            })
            .catch(reject);
        }, 2000);
      });
      req.on("error", (e) => { console.error("Không vào được :3000:", e.message); process.exit(1); });
    });
  })
  .catch((e) => { console.error("ERR", e.message); process.exit(1); });
