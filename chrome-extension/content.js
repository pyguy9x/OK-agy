// Content script running on dhtn.dcs.vn and web pages
// STRICT & ANTI-SPAM PROTECTED:
// 1. Chỉ cửa sổ chính (Top window) mới được kích hoạt cảnh báo, iframe chỉ cung cấp dữ liệu.
// 2. Không dùng MutationObserver kích hoạt gửi tin để tránh bão tin nhắn từ đồng hồ/ticker.
// 3. Quét định kỳ nhẹ nhàng mỗi 10 giây.

(function () {
  const TARGET_URL = "https://dhtn.dcs.vn/app-view/theme/admin-ex/pages/main.zul";
  const isIframe = window !== window.top;

  function isContextValid() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  }

  function cleanupIfInvalidated() {
    if (!isContextValid()) {
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
      if (reloadTimer) {
        clearInterval(reloadTimer);
        reloadTimer = null;
      }
      return true;
    }
    return false;
  }

  function isTargetReloadPage() {
    try {
      const cleanUrl = window.location.href.split("?")[0].split("#")[0];
      return cleanUrl === TARGET_URL || cleanUrl.endsWith("/app-view/theme/admin-ex/pages/main.zul");
    } catch (_) {
      return false;
    }
  }

  let config = {
    enabled: true,
    autoReloadMinutes: 5,
    watchDenTiepNhan: true,
    watchDiCapSo: true
  };

  let checkTimer = null;
  let reloadTimer = null;

  async function loadConfig() {
    if (cleanupIfInvalidated()) return;
    try {
      const stored = await chrome.storage.local.get([
        "enabled",
        "autoReloadMinutes",
        "watchDenTiepNhan",
        "watchDiCapSo"
      ]);
      if (stored.enabled !== undefined) config.enabled = stored.enabled;
      if (stored.autoReloadMinutes !== undefined) config.autoReloadMinutes = stored.autoReloadMinutes;
      if (stored.watchDenTiepNhan !== undefined) config.watchDenTiepNhan = stored.watchDenTiepNhan;
      if (stored.watchDiCapSo !== undefined) config.watchDiCapSo = stored.watchDiCapSo;
      setupAutoReload();
    } catch (_) {}
  }

  // Find number count for target phrase
  function findCountForKeyword(doc, keywords) {
    let maxFound = -1;

    try {
      // 1. Text walker method
      const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      const matchingContainers = [];

      while ((node = walker.nextNode())) {
        const val = node.nodeValue.trim().toLowerCase();
        for (const kw of keywords) {
          if (val === kw || (val.includes(kw) && val.length < 60)) {
            matchingContainers.push(node.parentElement);
            break;
          }
        }
      }

      matchingContainers.forEach((el) => {
        if (!el) return;
        let curr = el;
        for (let d = 0; d < 4; d++) {
          if (!curr || !curr.parentElement) break;
          curr = curr.parentElement;

          const badgeEls = curr.querySelectorAll('.count-number, [class*="count-number"]');
          badgeEls.forEach((b) => {
            const m = (b.textContent || "").trim().match(/\d+/);
            if (m) {
              const n = parseInt(m[0], 10);
              if (n > maxFound) maxFound = n;
            }
          });

          const numEls = curr.querySelectorAll('span, div, b, strong, p');
          numEls.forEach((ch) => {
            if (ch === el) return;
            const t = (ch.textContent || "").trim();
            if (/^\d+$/.test(t)) {
              const n = parseInt(t, 10);
              if (n > maxFound) maxFound = n;
            }
          });
        }
      });

      // 2. Class search
      const badgeEls = doc.querySelectorAll('.count-number, .z-label.count-number, [class*="count-number"]');
      badgeEls.forEach((b) => {
        const text = (b.textContent || "").trim();
        const m = text.match(/\d+/);
        if (!m) return;
        const num = parseInt(m[0], 10);

        let ctx = "";
        let p = b.parentElement;
        for (let d = 0; d < 6 && p; d++) {
          ctx += " " + (p.textContent || "");
          p = p.parentElement;
        }
        ctx = ctx.toLowerCase();

        for (const kw of keywords) {
          if (ctx.includes(kw)) {
            if (num > maxFound) maxFound = num;
            break;
          }
        }
      });
    } catch (_) {}

    return maxFound;
  }

  // Deep scan
  function inspectAllFrames() {
    let maxDen = -1; // Văn bản đến > Chờ tiếp nhận
    let maxDi = -1;  // Văn bản đi > Chờ cấp số

    const kwDen = ["chờ tiếp nhận", "cho tiep nhan", "tiếp nhận"];
    const kwDi = ["chờ cấp số", "cho cap so", "cấp số"];

    function scanDoc(doc) {
      if (!doc) return;
      try {
        const d = findCountForKeyword(doc, kwDen);
        if (d > maxDen) maxDen = d;

        const s = findCountForKeyword(doc, kwDi);
        if (s > maxDi) maxDi = s;

        doc.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) scanDoc(el.shadowRoot);
        });

        doc.querySelectorAll("iframe, frame").forEach((ifr) => {
          try {
            const iDoc = ifr.contentDocument || ifr.contentWindow?.document;
            if (iDoc) scanDoc(iDoc);
          } catch (_) {}
        });
      } catch (_) {}
    }

    scanDoc(document);

    const items = [];
    const nonZeroItems = [];

    // 1. Chờ tiếp nhận (Văn bản đến)
    if (maxDen >= 0) {
      const itemDen = {
        type: "den_tiep_nhan",
        title: "Văn bản đến > Chờ tiếp nhận",
        count: String(maxDen),
        isMonitored: config.watchDenTiepNhan !== false
      };
      items.push(itemDen);
      if (itemDen.isMonitored && maxDen > 0) {
        nonZeroItems.push(itemDen);
      }
    }

    // 2. Chờ cấp số (Văn bản đi)
    if (maxDi >= 0) {
      const itemDi = {
        type: "di_cap_so",
        title: "Văn bản đi > Chờ cấp số",
        count: String(maxDi),
        isMonitored: config.watchDiCapSo !== false
      };
      items.push(itemDi);
      if (itemDi.isMonitored && maxDi > 0) {
        nonZeroItems.push(itemDi);
      }
    }

    return {
      found: items.length > 0,
      items,
      nonZeroItems,
      curDen: maxDen >= 0 ? maxDen : 0,
      curDi: maxDi >= 0 ? maxDi : 0
    };
  }

  // Checking routine
  function checkAndNotify() {
    if (cleanupIfInvalidated()) return;
    if (!config.enabled) return;

    const res = inspectAllFrames();

    if (!isContextValid()) return;

    // Báo trạng thái để popup hiển thị
    try {
      chrome.runtime.sendMessage({
        action: "report_tab_state",
        found: res.found,
        items: res.items,
        nonZeroItems: res.nonZeroItems,
        url: window.location.href,
        isIframe
      }).catch(() => {});
    } catch (_) {}

    // TUYỆT ĐỐI CHỈ CỬA SỔ CHÍNH (TOP WINDOW) MỚI ĐƯỢC GỬI ALERT
    if (isIframe) {
      return;
    }

    // Gửi yêu cầu kiểm tra đến background
    try {
      chrome.runtime.sendMessage(
        {
          action: "send_alert",
          curDen: res.curDen,
          curDi: res.curDi,
          items: res.nonZeroItems
        },
        () => {
          // Xử lý callback nếu cần
          if (chrome.runtime.lastError) {}
        }
      );
    } catch (_) {}
  }

  // Tự động F5 duy nhất trang main.zul
  function setupAutoReload() {
    if (isIframe) return;
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }

    if (!isTargetReloadPage()) return;

    const minutes = parseInt(config.autoReloadMinutes, 10);
    if (minutes && minutes > 0) {
      const ms = minutes * 60 * 1000;
      reloadTimer = setInterval(() => {
        if (cleanupIfInvalidated()) return;
        if (!isTargetReloadPage()) return;

        const active = document.activeElement;
        const isTyping = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
        const hasModal = document.querySelector(".z-window-modal, .z-messagebox-window");

        if (!isTyping && !hasModal) {
          console.log("[DHTN Monitor] Tự động F5 trang main.zul...");
          window.location.reload();
        }
      }, ms);
    }
  }

  // Storage listener
  if (isContextValid()) {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (cleanupIfInvalidated()) return;
        if (areaName === "local") {
          if (changes.enabled) config.enabled = changes.enabled.newValue;
          if (changes.watchDenTiepNhan) config.watchDenTiepNhan = changes.watchDenTiepNhan.newValue;
          if (changes.watchDiCapSo) config.watchDiCapSo = changes.watchDiCapSo.newValue;
          if (changes.autoReloadMinutes) {
            config.autoReloadMinutes = changes.autoReloadMinutes.newValue;
            setupAutoReload();
          }
        }
      });
    } catch (_) {}
  }

  // Popup inspect
  if (isContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (cleanupIfInvalidated()) return;
        if (request.action === "inspect_page") {
          const res = inspectAllFrames();
          sendResponse({
            ...res,
            config
          });
          return true;
        }
      });
    } catch (_) {}
  }

  // Khởi động
  loadConfig().then(() => {
    if (cleanupIfInvalidated()) return;
    // Chạy kiểm tra định kỳ mỗi 10 giây (hoàn toàn tĩnh lặng, không dùng MutationObserver)
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      if (!cleanupIfInvalidated()) {
        checkAndNotify();
      }
    }, 10000);

    // Chạy lần đầu sau 2 giây
    setTimeout(checkAndNotify, 2000);
  });
})();
