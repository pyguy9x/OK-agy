// Popup JS logic for DHTN Document Monitor

document.addEventListener("DOMContentLoaded", async () => {
  const enabledCheck = document.getElementById("enabledCheck");
  const badgeState = document.getElementById("badgeState");
  const chkDiCapSo = document.getElementById("chkDiCapSo");
  const chkDenTiepNhan = document.getElementById("chkDenTiepNhan");
  const botTokenInput = document.getElementById("botToken");
  const chatIdInput = document.getElementById("chatId");
  const autoReloadSelect = document.getElementById("autoReload");
  const toggleTokenBtn = document.getElementById("toggleToken");
  const btnSave = document.getElementById("btnSave");
  const btnTest = document.getElementById("btnTest");
  const statusMsg = document.getElementById("statusMsg");
  const liveItems = document.getElementById("liveItems");
  const tabDomain = document.getElementById("tabDomain");

  function showMsg(text, isError = false) {
    statusMsg.textContent = text;
    statusMsg.className = "status-msg " + (isError ? "error" : "success");
    statusMsg.style.display = "block";
    setTimeout(() => {
      statusMsg.style.display = "none";
    }, 4500);
  }

  function updateBadge(enabled) {
    if (enabled) {
      badgeState.textContent = "Đang bật";
      badgeState.className = "status-badge active";
    } else {
      badgeState.textContent = "Đang tắt";
      badgeState.className = "status-badge inactive";
    }
  }

  // Load saved config
  const config = await chrome.storage.local.get([
    "botToken",
    "chatId",
    "enabled",
    "autoReloadMinutes",
    "watchDenTiepNhan",
    "watchDiCapSo"
  ]);

  if (config.botToken !== undefined) botTokenInput.value = config.botToken;
  if (config.chatId !== undefined) chatIdInput.value = config.chatId;
  if (config.autoReloadMinutes !== undefined) autoReloadSelect.value = String(config.autoReloadMinutes);

  chkDiCapSo.checked = config.watchDiCapSo !== false;
  chkDenTiepNhan.checked = config.watchDenTiepNhan !== false;

  const isEnabled = config.enabled !== false;
  enabledCheck.checked = isEnabled;
  updateBadge(isEnabled);

  // Toggle token visibility
  toggleTokenBtn.addEventListener("click", () => {
    if (botTokenInput.type === "password") {
      botTokenInput.type = "text";
      toggleTokenBtn.textContent = "🔒";
    } else {
      botTokenInput.type = "password";
      toggleTokenBtn.textContent = "👁️";
    }
  });

  // Toggle enabled
  enabledCheck.addEventListener("change", async () => {
    const enabled = enabledCheck.checked;
    await chrome.storage.local.set({ enabled });
    updateBadge(enabled);
  });

  // Save config
  btnSave.addEventListener("click", async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();
    const autoReloadMinutes = parseInt(autoReloadSelect.value, 10) || 0;
    const watchDiCapSo = chkDiCapSo.checked;
    const watchDenTiepNhan = chkDenTiepNhan.checked;
    const enabled = enabledCheck.checked;

    if (!botToken || !chatId) {
      showMsg("Vui lòng nhập Telegram Bot Token và Chat ID!", true);
      return;
    }

    await chrome.storage.local.set({
      botToken,
      chatId,
      autoReloadMinutes,
      watchDiCapSo,
      watchDenTiepNhan,
      enabled
    });

    showMsg("✅ Đã lưu cài đặt thành công!");
    refreshStatus();
  });

  // Test Telegram button
  btnTest.addEventListener("click", async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();

    if (!botToken || !chatId) {
      showMsg("Vui lòng điền Bot Token & Chat ID trước khi test!", true);
      return;
    }

    btnTest.textContent = "Đang gửi...";
    btnTest.disabled = true;

    chrome.runtime.sendMessage(
      {
        action: "test_telegram",
        botToken,
        chatId
      },
      (res) => {
        btnTest.textContent = "🔔 Test Telegram";
        btnTest.disabled = false;

        if (chrome.runtime.lastError) {
          showMsg("Lỗi: " + chrome.runtime.lastError.message, true);
          return;
        }

        if (res && res.success) {
          showMsg("✅ Gửi tin nhắn Telegram thành công! Hãy kiểm tra Telegram.");
        } else {
          showMsg("❌ Thất bại: " + (res?.error || "Không gửi được"), true);
        }
      }
    );
  });

  // Render items in popup list
  function renderItems(items) {
    if (!items || items.length === 0) {
      liveItems.innerHTML = '<span class="item-tag">Không tìm thấy 2 mục này (Hãy F5 tab DHTN)</span>';
      return;
    }

    liveItems.innerHTML = "";
    items.forEach((item) => {
      const isNonZero = item.count !== "0";
      const tag = document.createElement("div");
      tag.className = "item-tag" + (isNonZero && item.isMonitored ? " alert" : "");
      const statusIcon = item.isMonitored ? (isNonZero ? "🚨 CÓ VĂN BẢN" : "✓") : "⚪ Không bật";
      tag.innerHTML = `
        <span>${item.title}</span>
        <span><span class="num">${item.count}</span> ${statusIcon}</span>
      `;
      liveItems.appendChild(tag);
    });
  }

  // Refresh status from tab and background
  function refreshStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        liveItems.innerHTML = '<span class="item-tag">Không tìm thấy tab</span>';
        return;
      }

      const activeTab = tabs[0];
      try {
        const u = new URL(activeTab.url);
        tabDomain.textContent = u.hostname;
      } catch (_) {
        tabDomain.textContent = "Tab hiện tại";
      }

      if (!activeTab.url || activeTab.url.startsWith("chrome://")) {
        liveItems.innerHTML = '<span class="item-tag">Trang nội bộ trình duyệt</span>';
        return;
      }

      // Check background cache first
      chrome.runtime.sendMessage({ action: "get_tab_status", tabId: activeTab.id }, (bgRes) => {
        if (bgRes && bgRes.found && bgRes.items && bgRes.items.length > 0) {
          renderItems(bgRes.items);
        } else {
          // Direct inspect message to content script
          chrome.tabs.sendMessage(activeTab.id, { action: "inspect_page" }, (res) => {
            if (chrome.runtime.lastError || !res) {
              liveItems.innerHTML = '<span class="item-tag">Chưa kết nối tab. Hãy nhấn F5 trên tab DHTN!</span>';
              return;
            }

            if (!res.found || !res.items || res.items.length === 0) {
              liveItems.innerHTML = '<span class="item-tag">Đang chờ trang tải xong (nhấn F5 tab DHTN).</span>';
              return;
            }

            renderItems(res.items);
          });
        }
      });
    });
  }

  refreshStatus();
});
