// Content script running on dhtn.dcs.vn and web pages (all frames)
// STRICT MODE: ONLY monitors:
// 1. "Văn bản đến > Chờ tiếp nhận"
// 2. "Văn bản đi > Chờ cấp số"

(function () {
  // Helper to check if extension context is still valid (prevents "Extension context invalidated")
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
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return true;
    }
    return false;
  }

  let config = {
    selector: ".count-number, [class*='count-number']",
    enabled: true,
    cooldownSeconds: 3,
    autoReloadMinutes: 5,
    watchDenTiepNhan: true, // Văn bản đến > Chờ tiếp nhận
    watchDiCapSo: true      // Văn bản đi > Chờ cấp số
  };

  let lastSignature = "";
  let lastAlertTime = 0;
  let observer = null;
  let checkTimer = null;
  let reloadTimer = null;
  const isIframe = window !== window.top;

  // Load configuration from storage
  async function loadConfig() {
    if (cleanupIfInvalidated()) return;
    try {
      const stored = await chrome.storage.local.get([
        "selector",
        "enabled",
        "cooldownSeconds",
        "autoReloadMinutes",
        "watchDenTiepNhan",
        "watchDiCapSo"
      ]);
      if (stored.selector !== undefined) config.selector = stored.selector;
      if (stored.enabled !== undefined) config.enabled = stored.enabled;
      if (stored.cooldownSeconds !== undefined) config.cooldownSeconds = stored.cooldownSeconds;
      if (stored.autoReloadMinutes !== undefined) config.autoReloadMinutes = stored.autoReloadMinutes;
      if (stored.watchDenTiepNhan !== undefined) config.watchDenTiepNhan = stored.watchDenTiepNhan;
      if (stored.watchDiCapSo !== undefined) config.watchDiCapSo = stored.watchDiCapSo;
      setupAutoReload();
    } catch (e) {
      // Ignored if invalidated
    }
  }

  // Deep scanner for elements across current document + child iframes + shadow roots
  function queryAllElementsDeep() {
    const list = [];
    const seen = new Set();

    function scan(doc, frameInfo) {
      if (!doc) return;
      try {
        const selectors = [
          ".count-number",
          ".z-label.count-number",
          "span.count-number",
          "[class*='count-number']"
        ];
        
        selectors.forEach((sel) => {
          doc.querySelectorAll(sel).forEach((el) => {
            if (!seen.has(el)) {
              seen.add(el);
              list.push({ el, doc, frameInfo });
            }
          });
        });

        // Scan shadow DOMs
        doc.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) {
            scan(el.shadowRoot, frameInfo + " > shadow");
          }
        });

        // Scan child iframes
        doc.querySelectorAll("iframe, frame").forEach((ifr, i) => {
          try {
            const iDoc = ifr.contentDocument || ifr.contentWindow?.document;
            if (iDoc) {
              scan(iDoc, frameInfo + ` > iframe[${i}]`);
            }
          } catch (_) {}
        });
      } catch (_) {}
    }

    scan(document, isIframe ? "iframe" : "top");
    return list;
  }

  // Strictly identify: "Văn bản đến > Chờ tiếp nhận" OR "Văn bản đi > Chờ cấp số"
  function identifyCounter(el) {
    if (!el) return null;

    let contextParts = [];

    const selfTitle = el.getAttribute("title") || el.getAttribute("aria-label") || "";
    if (selfTitle) contextParts.push(selfTitle);

    let prev = el.previousElementSibling;
    while (prev) {
      const t = prev.textContent.trim();
      if (t) contextParts.push(t);
      prev = prev.previousElementSibling;
    }

    let next = el.nextElementSibling;
    while (next) {
      const t = next.textContent.trim();
      if (t) contextParts.push(t);
      next = next.nextElementSibling;
    }

    let curr = el.parentElement;
    let depth = 0;
    while (curr && depth < 8) {
      const labelEl = curr.querySelector(
        '.expand-sub-menu-name-text, .expand-menu-name-text, .collapse-sub-menu-name-text, .collapse-menu-name-text, .card-title, .box-title, h1, h2, h3, h4, h5, .header-title'
      );
      if (labelEl && labelEl !== el && labelEl.textContent.trim()) {
        contextParts.push(labelEl.textContent.trim());
      }

      const text = curr.textContent || "";
      if (text.includes("tiếp nhận") || text.includes("ti?p nh?n") ||
          text.includes("cấp số") || text.includes("c?p s?") ||
          text.includes("VĂN BẢN") || text.includes("Văn bản")) {
        contextParts.push(text);
      }

      curr = curr.parentElement;
      depth++;
    }

    const fullText = contextParts.join(" ").toLowerCase();

    // 1. "Văn bản đến > Chờ tiếp nhận"
    const hasTiepNhan = fullText.includes("chờ tiếp nhận") || fullText.includes("cho tiep nhan") || fullText.includes("tiếp nhận");
    if (hasTiepNhan) {
      return {
        type: "den_tiep_nhan",
        title: "Văn bản đến > Chờ tiếp nhận",
        matched: config.watchDenTiepNhan !== false
      };
    }

    // 2. "Văn bản đi > Chờ cấp số"
    const hasCapSo = fullText.includes("chờ cấp số") || fullText.includes("cho cap so") || fullText.includes("cấp số");
    if (hasCapSo) {
      return {
        type: "di_cap_so",
        title: "Văn bản đi > Chờ cấp số",
        matched: config.watchDiCapSo !== false
      };
    }

    // STRICT: Bỏ qua tất cả các mục khác ngoài 2 mục trên
    return null;
  }

  // Inspect elements on page
  function inspectElements() {
    if (!config.enabled) return { found: false, items: [], nonZeroItems: [] };

    const matches = queryAllElementsDeep();
    if (matches.length === 0) {
      return { found: false, items: [], nonZeroItems: [] };
    }

    const items = [];
    const nonZeroItems = [];
    const seenTitles = new Set();

    matches.forEach(({ el, frameInfo }, index) => {
      const val = (el.textContent || el.innerText || "").trim();
      if (val !== "") {
        const info = identifyCounter(el);
        if (info && !seenTitles.has(info.title)) {
          seenTitles.add(info.title);
          const itemData = {
            type: info.type,
            title: info.title,
            count: val,
            isMonitored: info.matched,
            frame: frameInfo,
            html: el.outerHTML,
            index
          };
          items.push(itemData);

          if (info.matched && val !== "0") {
            nonZeroItems.push(itemData);
          }
        }
      }
    });

    return {
      found: items.length > 0,
      items,
      nonZeroItems,
      isIframe
    };
  }

  // Check and alert
  function checkAndNotify() {
    if (cleanupIfInvalidated()) return;
    if (!config.enabled) return;

    const { found, items, nonZeroItems } = inspectElements();

    // Report state to background for popup
    if (isContextValid()) {
      try {
        chrome.runtime.sendMessage({
          action: "report_tab_state",
          found,
          items,
          nonZeroItems,
          url: window.location.href,
          isIframe
        }).catch(() => {});
      } catch (_) {}
    }

    if (!found || nonZeroItems.length === 0) {
      if (lastSignature !== "") {
        lastSignature = "";
      }
      return;
    }

    const currentSignature = nonZeroItems.map((it) => `${it.title}:${it.count}`).join("|");
    const now = Date.now();
    const cooldownMs = (config.cooldownSeconds || 3) * 1000;

    if (currentSignature !== lastSignature && (now - lastAlertTime > cooldownMs)) {
      lastSignature = currentSignature;
      lastAlertTime = now;

      if (!isContextValid()) return;

      try {
        chrome.runtime.sendMessage(
          {
            action: "send_alert",
            items: nonZeroItems,
            count: currentSignature
          },
          (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.success) {
              console.log("[DHTN Monitor] ✅ Đã gửi Telegram thành công!");
            }
          }
        );
      } catch (_) {}
    }
  }

  // Setup auto reload
  function setupAutoReload() {
    if (isIframe) return;
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }

    const minutes = parseInt(config.autoReloadMinutes, 10);
    if (minutes && minutes > 0) {
      const ms = minutes * 60 * 1000;
      reloadTimer = setInterval(() => {
        if (cleanupIfInvalidated()) return;
        const active = document.activeElement;
        const isTyping = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
        if (!isTyping) {
          window.location.reload();
        }
      }, ms);
    }
  }

  let debounceTimeout = null;
  function triggerCheckDebounced() {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      if (!cleanupIfInvalidated()) {
        checkAndNotify();
      }
    }, 300);
  }

  // Observer
  function setupObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    observer = new MutationObserver(() => {
      triggerCheckDebounced();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      if (!cleanupIfInvalidated()) {
        checkAndNotify();
      }
    }, 2500);
  }

  // Storage listener
  if (isContextValid()) {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (cleanupIfInvalidated()) return;
        if (areaName === "local") {
          if (changes.selector) config.selector = changes.selector.newValue;
          if (changes.enabled) config.enabled = changes.enabled.newValue;
          if (changes.cooldownSeconds) config.cooldownSeconds = changes.cooldownSeconds.newValue;
          if (changes.watchDenTiepNhan) config.watchDenTiepNhan = changes.watchDenTiepNhan.newValue;
          if (changes.watchDiCapSo) config.watchDiCapSo = changes.watchDiCapSo.newValue;
          if (changes.autoReloadMinutes) {
            config.autoReloadMinutes = changes.autoReloadMinutes.newValue;
            setupAutoReload();
          }
          checkAndNotify();
        }
      });
    } catch (_) {}
  }

  // Popup inspection listener
  if (isContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (cleanupIfInvalidated()) return;
        if (request.action === "inspect_page") {
          const res = inspectElements();
          sendResponse({
            ...res,
            lastSignature,
            config
          });
          return true;
        }
      });
    } catch (_) {}
  }

  // Init
  loadConfig().then(() => {
    if (cleanupIfInvalidated()) return;
    setupObserver();
    setTimeout(checkAndNotify, 1000);
  });
})();
