// background.js - Manifest V3 Service Worker for Zalo to Telegram

const DEFAULT_CONFIG = {
  botToken: "8909257392:AAG9kRxzryLLepvGDMKs_u44dnPY7hEm1lY",
  chatId: "928852403",
  enabled: true,
  filterMode: "whitelist", // 'whitelist': chỉ gửi nhóm trong danh sách; 'all': gửi tất cả
  groupsText: "",
  skipText: "",
  sentCountToday: 0,
  recentLogs: []
};

// Initialize settings on install or startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Zalo2Tele] Đang khởi tạo extension...");
  const current = await chrome.storage.local.get(null);
  const toSet = {};

  for (const [key, val] of Object.entries(DEFAULT_CONFIG)) {
    if (current[key] === undefined) {
      toSet[key] = val;
    }
  }

  // Load default group files if not present
  if (!current.groupsText) {
    try {
      const res = await fetch(chrome.runtime.getURL("danh_sach_202_nhom.txt"));
      toSet.groupsText = await res.text();
    } catch (e) {
      console.warn("[Zalo2Tele] Không thể nạp danh_sach_202_nhom.txt:", e);
    }
  }

  if (!current.skipText) {
    try {
      const res = await fetch(chrome.runtime.getURL("bo_qua_nhom.txt"));
      toSet.skipText = await res.text();
    } catch (e) {
      console.warn("[Zalo2Tele] Không thể nạp bo_qua_nhom.txt:", e);
    }
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  updateBadge(current.enabled !== false);
  console.log("[Zalo2Tele] Khởi tạo thành công!");
});

// Update extension icon badge
async function updateBadge(enabled) {
  try {
    if (!enabled) {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      const data = await chrome.storage.local.get(["sentCountToday"]);
      const count = data.sentCountToday || 0;
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    }
  } catch (e) {}
}

// Escape HTML for Telegram
function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Parse whitelist groups from text
function parseGroupList(rawText) {
  const mapById = new Map();
  const listByName = [];
  const lines = (rawText || "").split(/\r?\n/);

  for (const line of lines) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;
    const parts = clean.split("|").map((s) => s.trim());
    const ten = parts[0] || "";
    const threadId = (parts[1] || "").replace(/\D/g, "");
    const mem = parts[2] || "";
    const chatId = parts[3] || "";

    const item = { ten, threadId, mem, chatId };
    if (threadId) {
      mapById.set(threadId, item);
    }
    if (ten) {
      listByName.push({ ...item, cleanTen: ten.toLowerCase() });
    }
  }

  return { mapById, listByName };
}

// Parse skip list from text
function parseSkipSet(rawText) {
  const set = new Set();
  const lines = (rawText || "").split(/\r?\n/);
  for (const line of lines) {
    const clean = line.replace(/#.*$/, "").trim();
    const id = clean.replace(/\D/g, "");
    if (id) set.add(id);
    else if (clean) set.add(clean.toLowerCase());
  }
  return set;
}

// Match an incoming group against whitelist
function matchGroup(groupName, threadId, { mapById, listByName }) {
  // 1. Match by thread ID
  if (threadId && mapById.has(threadId)) {
    return mapById.get(threadId);
  }

  // 2. Match by group name (exact or substring)
  if (groupName) {
    const cleanName = groupName.trim().toLowerCase();
    // Exact match
    const exact = listByName.find((item) => item.cleanTen === cleanName);
    if (exact) return exact;

    // Substring match
    const partial = listByName.find(
      (item) => cleanName.includes(item.cleanTen) || item.cleanTen.includes(cleanName)
    );
    if (partial) return partial;
  }

  return null;
}

// Send message via Telegram Bot API
async function sendTelegramMessage(botToken, chatId, htmlText) {
  if (!botToken || !chatId) {
    throw new Error("Chưa cấu hình Telegram Bot Token hoặc Chat ID!");
  }

  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId.trim(),
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const resJson = await response.json();
  if (!response.ok || !resJson.ok) {
    throw new Error(resJson.description || `HTTP ${response.status}`);
  }
  return resJson;
}

// Record activity log (keeps last 50 entries)
async function recordLog(logEntry) {
  try {
    const data = await chrome.storage.local.get(["recentLogs"]);
    const logs = data.recentLogs || [];
    logs.unshift({
      ...logEntry,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    });
    if (logs.length > 50) logs.pop();
    await chrome.storage.local.set({ recentLogs: logs });
  } catch (e) {}
}

// Message Router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "send_zalo_message") {
    (async () => {
      try {
        const config = await chrome.storage.local.get([
          "botToken",
          "chatId",
          "enabled",
          "filterMode",
          "groupsText",
          "skipText",
          "sentCountToday"
        ]);

        if (config.enabled === false) {
          return sendResponse({ success: false, reason: "Extension đang tắt" });
        }

        const msgData = request.data || {};
        const { groupName, sender: msgSender, text, threadId, source } = msgData;

        // Check skip list
        const skipSet = parseSkipSet(config.skipText);
        if (threadId && skipSet.has(threadId)) {
          console.log(`[Zalo2Tele] 🚫 Bỏ qua nhóm ID ${threadId} (${groupName})`);
          await recordLog({
            status: "skipped",
            group: groupName,
            sender: msgSender,
            text: text.slice(0, 40),
            reason: "Nằm trong danh sách bỏ qua"
          });
          return sendResponse({ success: false, reason: "Bỏ qua theo danh sách" });
        }
        if (groupName && skipSet.has(groupName.trim().toLowerCase())) {
          console.log(`[Zalo2Tele] 🚫 Bỏ qua nhóm tên "${groupName}"`);
          await recordLog({
            status: "skipped",
            group: groupName,
            sender: msgSender,
            text: text.slice(0, 40),
            reason: "Nằm trong danh sách bỏ qua"
          });
          return sendResponse({ success: false, reason: "Bỏ qua theo tên nhóm" });
        }

        // Check whitelist if mode is "whitelist"
        let targetChatId = config.chatId;
        let matchedGroupName = groupName;

        if (config.filterMode !== "all") {
          const parsedGroups = parseGroupList(config.groupsText);
          const matched = matchGroup(groupName, threadId, parsedGroups);

          if (!matched) {
            console.log(`[Zalo2Tele] ⏭️ Bỏ qua nhóm "${groupName}" - Không có trong 202 nhóm`);
            await recordLog({
              status: "ignored",
              group: groupName,
              sender: msgSender,
              text: text.slice(0, 40),
              reason: "Không thuộc 202 nhóm cho phép"
            });
            return sendResponse({ success: false, reason: "Không thuộc danh sách cho phép" });
          }

          matchedGroupName = matched.ten || groupName;
          if (matched.chatId) {
            targetChatId = matched.chatId;
          }
        }

        // Format Telegram Message
        const nowTime = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const nowDate = new Date().toLocaleDateString("vi-VN");

        const telegramText =
          `👥 <b>[${escapeHtml(matchedGroupName)}]</b>\n` +
          `👤 <b>Người gửi:</b> ${escapeHtml(msgSender || "Thành viên")}\n\n` +
          `💬 <b>Nội dung:</b>\n${escapeHtml(text)}\n\n` +
          `⏰ <i>${nowTime} (${nowDate})</i> • 🌐 <a href="https://chat.zalo.me">Zalo Web</a>`;

        await sendTelegramMessage(config.botToken, targetChatId, telegramText);

        const newCount = (config.sentCountToday || 0) + 1;
        await chrome.storage.local.set({ sentCountToday: newCount });
        updateBadge(true);

        await recordLog({
          status: "success",
          group: matchedGroupName,
          sender: msgSender,
          text: text.slice(0, 40),
          chatId: targetChatId
        });

        console.log(`[Zalo2Tele] 🚀 Đã gửi Telegram thành công tới ${targetChatId}:`, {
          group: matchedGroupName,
          sender: msgSender
        });

        sendResponse({ success: true, count: newCount });
      } catch (err) {
        console.error("[Zalo2Tele] Lỗi gửi Telegram:", err);
        await recordLog({
          status: "error",
          group: request.data ? request.data.groupName : "Lỗi",
          text: err.message
        });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (request.action === "test_telegram") {
    (async () => {
      try {
        const { botToken, chatId } = request;
        const now = new Date().toLocaleString("vi-VN");
        const msg =
          `✅ <b>[Zalo to Telegram Extension] Test kết nối thành công!</b>\n\n` +
          `🤖 Bot đã sẵn sàng nhận tin nhắn từ Zalo Web theo danh sách nhóm.\n` +
          `⏰ <b>Thời gian:</b> ${now}\n` +
          `🔗 <b>Trạng thái:</b> Đang hoạt động`;

        await sendTelegramMessage(botToken, chatId, msg);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
