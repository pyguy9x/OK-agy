// Background Service Worker for Manifest V3

const DEFAULT_CONFIG = {
  botToken: "8909257392:AAG9kRxzryLLepvGDMKs_u44dnPY7hEm1lY",
  chatId: "928852403",
  selector: ".count-number, [class*='count-number']",
  enabled: true,
  autoReloadMinutes: 5,
  watchDenTiepNhan: true,
  watchDiCapSo: true
};

// Store aggregated status per tab
const tabStates = {};

// STRICT SPAM DEFENSE (In-Memory Synchronous State & Locks)
let isSendingAlert = false;
let lastAlertTimestamp = 0;
const MIN_ALERT_COOLDOWN_MS = 60000; // Ít nhất 60 GIÂY giữa 2 lần gửi tin Telegram!

// Memory cache of reported counts (prevents any async race conditions)
let inMemoryReportedState = { den: 0, di: 0 };

// Initialize on startup/install
chrome.runtime.onInstalled.addListener(async () => {
  await initStorage();
});

chrome.runtime.onStartup.addListener(async () => {
  await initStorage();
});

async function initStorage() {
  const current = await chrome.storage.local.get(null);
  const toSet = {};
  for (const [key, val] of Object.entries(DEFAULT_CONFIG)) {
    if (current[key] === undefined || current[key] === "") {
      toSet[key] = val;
    }
  }
  if (current.lastReportedState) {
    inMemoryReportedState = current.lastReportedState;
  } else {
    toSet.lastReportedState = inMemoryReportedState;
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  console.log("[DHTN Monitor] Khởi tạo an toàn:", inMemoryReportedState);
}

// Clean up tab states
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
});

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendTelegram(botToken, chatId, text) {
  const token = (botToken || DEFAULT_CONFIG.botToken).trim();
  const cid = (chatId || DEFAULT_CONFIG.chatId).trim();

  if (!token || !cid) {
    throw new Error("Chưa cấu hình Telegram Bot Token hoặc Chat ID!");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: cid,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `HTTP ${response.status}`);
  }
  return data;
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Update state from content scripts
  if (request.action === "report_tab_state" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabStates[tabId]) {
      tabStates[tabId] = { itemsMap: {}, lastUpdate: Date.now() };
    }

    if (Array.isArray(request.items) && request.items.length > 0) {
      request.items.forEach((item) => {
        const curCount = parseInt(tabStates[tabId].itemsMap[item.title]?.count, 10) || 0;
        const newCount = parseInt(item.count, 10) || 0;
        if (!tabStates[tabId].itemsMap[item.title] || newCount >= curCount) {
          tabStates[tabId].itemsMap[item.title] = item;
        }
      });
      tabStates[tabId].lastUpdate = Date.now();
      tabStates[tabId].url = request.url;
    }
    return;
  }

  // Popup query
  if (request.action === "get_tab_status") {
    const data = tabStates[request.tabId];
    if (data && data.itemsMap) {
      const items = Object.values(data.itemsMap);
      sendResponse({ found: items.length > 0, items, url: data.url });
    } else {
      sendResponse({ found: false, items: [] });
    }
    return true;
  }

  // STRICT ALERT HANDLER WITH SYNCHRONOUS LOCKING
  if (request.action === "send_alert") {
    const now = Date.now();
    const curDen = parseInt(request.curDen, 10) || 0;
    const curDi = parseInt(request.curDi, 10) || 0;

    // 1. CHẶN ĐỒNG THỜI: Nếu đang trong tiến trình gửi hoặc chưa hết 60s cooldown -> CHẶN NGAY LẬP TỨC
    if (isSendingAlert) {
      return sendResponse({ skipped: true, reason: "Already sending" });
    }

    if (now - lastAlertTimestamp < MIN_ALERT_COOLDOWN_MS) {
      return sendResponse({ skipped: true, reason: "Cooldown active (60s)" });
    }

    // 2. SO SÁNH ĐỒNG BỘ: Chỉ gửi nếu số lượng lớn hơn lần trước
    const prevDen = inMemoryReportedState.den || 0;
    const prevDi = inMemoryReportedState.di || 0;

    const isDenNew = curDen > 0 && curDen > prevDen;
    const isDiNew = curDi > 0 && curDi > prevDi;

    // Luôn đồng bộ in-memory state ngay lập tức để chặn mọi request đến sau trong cùng 1 tick
    inMemoryReportedState = {
      den: curDen,
      di: curDi
    };

    // Nếu không có mục nào tăng số lượng -> KHÔNG GỬI
    if (!isDenNew && !isDiNew) {
      return sendResponse({ skipped: true, reason: "No new doc" });
    }

    // 3. KHÓA TIẾN TRÌNH VÀ THỜI GIAN NGAY
    isSendingAlert = true;
    lastAlertTimestamp = now;

    // Tiến hành gửi Telegram an toàn
    (async () => {
      try {
        const settings = await chrome.storage.local.get(["botToken", "chatId", "enabled"]);
        if (settings.enabled === false) {
          isSendingAlert = false;
          return sendResponse({ success: false, reason: "Monitoring disabled" });
        }

        // Lưu vào storage bền bỉ
        await chrome.storage.local.set({ lastReportedState: inMemoryReportedState });

        const botToken = settings.botToken || DEFAULT_CONFIG.botToken;
        const chatId = settings.chatId || DEFAULT_CONFIG.chatId;

        const timeStr = new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
        const dateStr = new Date().toLocaleDateString("vi-VN");
        const pageTitle = sender.tab ? sender.tab.title : "Hệ thống DHTN";
        const pageUrl = sender.tab ? sender.tab.url : "https://dhtn.dcs.vn/app-view/theme/admin-ex/pages/main.zul";

        const alertLines = [];
        if (isDenNew) {
          alertLines.push(`📥 <b>Văn bản đến &gt; Chờ tiếp nhận:</b> <code>${curDen}</code> văn bản`);
        }
        if (isDiNew) {
          alertLines.push(`📤 <b>Văn bản đi &gt; Chờ cấp số:</b> <code>${curDi}</code> văn bản`);
        }

        const message = 
          `📑 <b>[HỆ THỐNG VĂN BẢN DHTN]</b>\n` +
          `🚨 <b>Phát hiện văn bản mới cần xử lý!</b>\n\n` +
          alertLines.join("\n") + `\n\n` +
          `⏰ <b>Thời gian:</b> ${timeStr} (${dateStr})\n` +
          `🌐 <b>Liên kết:</b> <a href="${escapeHtml(pageUrl)}">${escapeHtml(pageTitle)}</a>`;

        const res = await sendTelegram(botToken, chatId, message);
        console.log(`[DHTN Monitor] ✅ Gửi 1 tin Telegram thành công (Đến: ${curDen}, Đi: ${curDi})`);
        sendResponse({ success: true, res });
      } catch (err) {
        console.error("[DHTN Monitor] ❌ Lỗi gửi Telegram:", err);
        sendResponse({ success: false, error: err.message });
      } finally {
        isSendingAlert = false;
      }
    })();

    return true;
  }

  // Test Telegram button
  if (request.action === "test_telegram") {
    (async () => {
      try {
        const { botToken, chatId } = request;
        const now = new Date().toLocaleString("vi-VN");
        const message = 
          `✅ <b>[DHTN Văn Bản Monitor Test]</b> Kết nối thành công!\n` +
          `🤖 Tiện ích theo dõi Văn bản đến & Văn bản đi đã sẵn sàng.\n` +
          `⏰ <b>Thời gian:</b> ${now}`;

        await sendTelegram(botToken, chatId, message);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
