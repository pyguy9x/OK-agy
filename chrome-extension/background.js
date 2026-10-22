// Background Service Worker for Manifest V3

const DEFAULT_CONFIG = {
  botToken: "8909257392:AAG9kRxzryLLepvGDMKs_u44dnPY7hEm1lY",
  chatId: "928852403",
  selector: ".count-number, [class*='count-number']",
  enabled: true,
  cooldownSeconds: 3,
  autoReloadMinutes: 5,
  watchDenTiepNhan: true,
  watchDiCapSo: true,
  watchAllOthers: false
};

// Store aggregated status per tab (from all frames)
const tabStates = {};

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
});

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const toSet = {};
  for (const [key, val] of Object.entries(DEFAULT_CONFIG)) {
    if (current[key] === undefined) {
      toSet[key] = val;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  console.log("[DHTN Monitor] Khởi tạo extension thành công:", { ...DEFAULT_CONFIG, ...current });
});

// Escape HTML helper for Telegram HTML parse mode
function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper to send message via Telegram Bot API
async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) {
    throw new Error("Chưa cấu hình Telegram Bot Token hoặc Chat ID!");
  }

  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId.trim(),
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

// Handle runtime messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Content scripts reporting state from top or child iframes
  if (request.action === "report_tab_state" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabStates[tabId]) {
      tabStates[tabId] = { itemsMap: {}, lastUpdate: Date.now() };
    }

    if (Array.isArray(request.items) && request.items.length > 0) {
      // Merge items by title to avoid duplicates across frames
      request.items.forEach((item) => {
        tabStates[tabId].itemsMap[item.title] = item;
      });
      tabStates[tabId].lastUpdate = Date.now();
      tabStates[tabId].url = request.url;
    }
    return;
  }

  // Popup asking for aggregated state of current tab
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

  // Send Telegram alert
  if (request.action === "send_alert") {
    (async () => {
      try {
        const settings = await chrome.storage.local.get(["botToken", "chatId", "enabled"]);
        if (settings.enabled === false) {
          return sendResponse({ success: false, reason: "Monitoring disabled" });
        }

        const now = new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
        const dateStr = new Date().toLocaleDateString("vi-VN");
        const pageTitle = sender.tab ? sender.tab.title : "Hệ thống DHTN";
        const pageUrl = sender.tab ? sender.tab.url : "https://dhtn.dcs.vn/app-view/theme/admin-ex/pages/main.zul";

        let detailsText = "";
        if (Array.isArray(request.items) && request.items.length > 0) {
          detailsText = request.items
            .map((item) => `📌 <b>${escapeHtml(item.title)}:</b> <code>${escapeHtml(item.count)}</code> văn bản`)
            .join("\n");
        } else {
          detailsText = `🔢 <b>Số lượng:</b> <code>${escapeHtml(request.count || "Khác 0")}</code>`;
        }

        const message = 
          `📑 <b>[HỆ THỐNG VĂN BẢN DHTN]</b>\n` +
          `🚨 <b>Phát hiện văn bản mới cần xử lý!</b>\n\n` +
          `${detailsText}\n\n` +
          `⏰ <b>Thời gian:</b> ${now} (${dateStr})\n` +
          `🌐 <b>Liên kết:</b> <a href="${escapeHtml(pageUrl)}">${escapeHtml(pageTitle)}</a>`;

        const res = await sendTelegram(settings.botToken, settings.chatId, message);
        console.log("[DHTN Monitor] Đã gửi thông báo Telegram:", request.items || request.count);
        sendResponse({ success: true, res });
      } catch (err) {
        console.error("[DHTN Monitor] Lỗi gửi Telegram:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Test Telegram
  if (request.action === "test_telegram") {
    (async () => {
      try {
        const { botToken, chatId } = request;
        const now = new Date().toLocaleString("vi-VN");
        const message = 
          `✅ <b>[DHTN Văn Bản Monitor Test]</b> Kết nối thành công!\n` +
          `🤖 Chrome Extension theo dõi Văn bản đến / Văn bản đi đã sẵn sàng.\n` +
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
