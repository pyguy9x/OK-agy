// popup.js - Controller for Zalo to Telegram Extension Popup

document.addEventListener("DOMContentLoaded", async () => {
  const toggleEnabled = document.getElementById("toggleEnabled");
  const statusText = document.getElementById("statusText");
  const botTokenInput = document.getElementById("botToken");
  const chatIdInput = document.getElementById("chatId");
  const modeWhitelist = document.getElementById("modeWhitelist");
  const modeAll = document.getElementById("modeAll");
  const groupsText = document.getElementById("groupsText");
  const skipText = document.getElementById("skipText");
  const groupCount = document.getElementById("groupCount");
  const summaryGroupCount = document.getElementById("summaryGroupCount");
  const skipCount = document.getElementById("skipCount");
  const btnTestTele = document.getElementById("btnTestTele");
  const btnSave = document.getElementById("btnSave");
  const btnClearLogs = document.getElementById("btnClearLogs");
  const teleStatus = document.getElementById("teleStatus");
  const logsContainer = document.getElementById("logsContainer");

  // Load configuration from chrome storage
  const config = await chrome.storage.local.get([
    "botToken",
    "chatId",
    "enabled",
    "filterMode",
    "groupsText",
    "skipText",
    "recentLogs"
  ]);

  // Set default values if not yet set
  botTokenInput.value = config.botToken || "8909257392:AAG9kRxzryLLepvGDMKs_u44dnPY7hEm1lY";
  chatIdInput.value = config.chatId || "928852403";

  const isEnabled = config.enabled !== false;
  toggleEnabled.checked = isEnabled;
  updateStatusDisplay(isEnabled);

  if (config.filterMode === "all") {
    modeAll.checked = true;
  } else {
    modeWhitelist.checked = true;
  }

  // Load groupsText from file if empty
  if (config.groupsText) {
    groupsText.value = config.groupsText;
  } else {
    try {
      const res = await fetch(chrome.runtime.getURL("danh_sach_202_nhom.txt"));
      const text = await res.text();
      groupsText.value = text;
      await chrome.storage.local.set({ groupsText: text });
    } catch (e) {}
  }

  // Load skipText from file if empty
  if (config.skipText) {
    skipText.value = config.skipText;
  } else {
    try {
      const res = await fetch(chrome.runtime.getURL("bo_qua_nhom.txt"));
      const text = await res.text();
      skipText.value = text;
      await chrome.storage.local.set({ skipText: text });
    } catch (e) {}
  }

  updateCounters();
  renderLogs(config.recentLogs || []);

  // Event: Toggle enabled
  toggleEnabled.addEventListener("change", async () => {
    const enabled = toggleEnabled.checked;
    updateStatusDisplay(enabled);
    await chrome.storage.local.set({ enabled });
  });

  function updateStatusDisplay(enabled) {
    if (enabled) {
      statusText.textContent = "Đang bật";
      statusText.style.color = "#10b981";
    } else {
      statusText.textContent = "Đã tắt";
      statusText.style.color = "#ef4444";
    }
  }

  // Update line counters
  function updateCounters() {
    const gLines = groupsText.value.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    groupCount.textContent = `${gLines.length} nhóm`;
    summaryGroupCount.textContent = gLines.length;

    const sLines = skipText.value.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    skipCount.textContent = sLines.length;
  }

  groupsText.addEventListener("input", updateCounters);
  skipText.addEventListener("input", updateCounters);

  // Event: Save Settings
  btnSave.addEventListener("click", async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();
    const filterMode = modeAll.checked ? "all" : "whitelist";
    const gText = groupsText.value;
    const sText = skipText.value;

    if (!botToken || !chatId) {
      showStatus("Vui lòng nhập đầy đủ Bot Token và Chat ID!", "error");
      return;
    }

    btnSave.disabled = true;
    btnSave.textContent = "Đang lưu...";

    await chrome.storage.local.set({
      botToken,
      chatId,
      filterMode,
      groupsText: gText,
      skipText: sText
    });

    setTimeout(() => {
      btnSave.disabled = false;
      btnSave.textContent = "💾 Lưu cài đặt";
      showStatus("Đã lưu cài đặt thành công!", "success");
    }, 400);
  });

  // Event: Test Telegram Connection
  btnTestTele.addEventListener("click", async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();

    if (!botToken || !chatId) {
      showStatus("Vui lòng nhập Bot Token và Chat ID trước khi test!", "error");
      return;
    }

    btnTestTele.disabled = true;
    btnTestTele.textContent = "Đang gửi test...";

    chrome.runtime.sendMessage(
      {
        action: "test_telegram",
        botToken,
        chatId
      },
      (res) => {
        btnTestTele.disabled = false;
        btnTestTele.textContent = "🔔 Test kết nối Bot";

        if (res && res.success) {
          showStatus("✅ Gửi tin nhắn test thành công! Kiểm tra Telegram.", "success");
        } else {
          showStatus(`❌ Lỗi test: ${res ? res.error : "Không nhận được phản hồi"}`, "error");
        }
      }
    );
  });

  // Event: Clear logs
  btnClearLogs.addEventListener("click", async () => {
    await chrome.storage.local.set({ recentLogs: [] });
    renderLogs([]);
  });

  function showStatus(msg, type) {
    teleStatus.textContent = msg;
    teleStatus.className = `status-msg ${type}`;
    teleStatus.style.display = "block";
    setTimeout(() => {
      teleStatus.style.display = "none";
    }, 4000);
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logsContainer.innerHTML =
        '<div style="text-align: center; color: #94a3b8; padding: 12px 0;">Chưa có tin nhắn mới nào.</div>';
      return;
    }

    logsContainer.innerHTML = logs
      .map((item) => {
        let badgeIcon = "🚀";
        let statusClass = "success";
        if (item.status === "skipped" || item.status === "ignored") {
          badgeIcon = item.status === "skipped" ? "🚫" : "⏭️";
          statusClass = "skipped";
        } else if (item.status === "error") {
          badgeIcon = "❌";
          statusClass = "error";
        }

        const senderPart = item.sender ? ` [${escapeHtml(item.sender)}]` : "";
        const reasonPart = item.reason ? ` - ${escapeHtml(item.reason)}` : "";

        return `
          <div class="log-item ${statusClass}">
            <div class="log-top">
              <span class="log-group">${badgeIcon} ${escapeHtml(item.group || "Tin nhắn")}${senderPart}</span>
              <span>${escapeHtml(item.time || "")}</span>
            </div>
            <div class="log-text">${escapeHtml(item.text || "")}${reasonPart}</div>
          </div>
        `;
      })
      .join("");
  }

  // Escape HTML helper
  function escapeHtml(unsafe) {
    return String(unsafe || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Listen for background updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.recentLogs) {
      renderLogs(changes.recentLogs.newValue || []);
    }
  });
});
