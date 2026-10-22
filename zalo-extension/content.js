// content.js - Runs in ISOLATED world on https://chat.zalo.me/*

(function () {
  console.log("%c[Zalo2Tele] Content Script Loaded", "background: #0088cc; color: white; padding: 2px 6px; border-radius: 4px;");

  // In-memory cache for deduplication (signature -> timestamp)
  const sentSignatures = new Map();
  // Conversation state tracker for sidebar (key -> { snippet, unreadCount, time })
  const convState = new Map();

  let isInitialized = false;

  // Clean up old signatures every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of sentSignatures.entries()) {
      if (now - ts > 10 * 60 * 1000) {
        sentSignatures.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Normalize string for signature matching
  function cleanStr(str) {
    return String(str || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  // Generate deduplication signature
  function createSignature(groupName, sender, text) {
    const g = cleanStr(groupName);
    const s = cleanStr(sender);
    const t = cleanStr(text).slice(0, 120);
    return `${g}:::${s}:::${t}`;
  }

  // Send message to background service worker
  function dispatchMessage(msgData) {
    const { threadId, groupName, sender, text, source } = msgData;
    if (!text || !text.trim()) return;

    // Check if message is from self
    const cleanSender = (sender || "").trim();
    if (cleanSender === "Bạn" || cleanSender.startsWith("Bạn ") || cleanSender.toLowerCase().startsWith("bạn:")) {
      return;
    }
    if (text.startsWith("Bạn:") || text.startsWith("Bạn :")) {
      return;
    }

    const sig = createSignature(groupName, sender, text);
    const now = Date.now();

    if (sentSignatures.has(sig)) {
      return; // Already forwarded
    }

    sentSignatures.set(sig, now);

    console.log(`[Zalo2Tele] 📨 Phát hiện tin nhắn mới [${source}]:`, {
      groupName,
      sender,
      text: text.slice(0, 60),
      threadId
    });

    chrome.runtime.sendMessage(
      {
        action: "send_zalo_message",
        data: {
          threadId: threadId || "",
          groupName: groupName || "Nhóm Zalo",
          sender: sender || "Thành viên",
          text: text.trim(),
          source: source || "DOM",
          time: now
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Zalo2Tele] Lỗi gửi message tới background:", chrome.runtime.lastError.message);
        } else if (response) {
          console.log("[Zalo2Tele] Kết quả background:", response);
        }
      }
    );
  }

  // 1. Listen for Notification events from inject.js
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.type !== "ZALO2TELE_NOTIFICATION") {
      return;
    }

    const payload = event.data.payload || {};
    const title = (payload.title || "").trim();
    const body = (payload.body || "").trim();
    const tag = (payload.tag || "").trim();

    if (!title && !body) return;

    let groupName = title;
    let sender = "Thành viên";
    let threadId = "";

    // Extract thread ID if present in tag
    if (tag) {
      const match = tag.match(/\d{10,25}/);
      if (match) threadId = match[0];
    }

    // Parse "[Tên Nhóm] Tên Người Gửi" or "Tên Nhóm - Tên Người Gửi"
    if (title.startsWith("[") && title.includes("]")) {
      const closingIdx = title.indexOf("]");
      groupName = title.slice(1, closingIdx).trim();
      sender = title.slice(closingIdx + 1).trim() || "Thành viên";
    } else if (title.includes(" - ")) {
      const parts = title.split(" - ");
      groupName = parts[0].trim();
      sender = parts.slice(1).join(" - ").trim();
    } else if (title.includes(": ")) {
      const parts = title.split(": ");
      groupName = parts[0].trim();
      sender = parts.slice(1).join(": ").trim();
    }

    // Body might also have "Tên: Tin nhắn"
    let text = body;
    if (body.includes(": ") && sender === "Thành viên") {
      const firstColon = body.indexOf(": ");
      sender = body.slice(0, firstColon).trim();
      text = body.slice(firstColon + 2).trim();
    }

    dispatchMessage({
      threadId,
      groupName,
      sender,
      text,
      source: "Notification"
    });
  });

  // 2. Scan and parse a Conversation Item from the sidebar
  function parseConversationItem(el) {
    if (!el || !(el instanceof HTMLElement)) return null;

    // Extract threadId from id or data attributes
    const rawId = el.id || el.getAttribute("data-id") || el.getAttribute("data-thread-id") || "";
    let threadId = "";
    const idMatch = rawId.match(/\d{10,25}/);
    if (idMatch) threadId = idMatch[0];

    // Find Title / Group Name
    let groupName = "";
    const titleEl = el.querySelector(
      '.conv-item-title__name, .conv-item-title, .truncate[title], [data-id="conv-title"], .name, .title'
    );
    if (titleEl) {
      groupName = titleEl.getAttribute("title") || titleEl.textContent.trim();
    }
    if (!groupName) {
      const anyTitle = el.querySelector('[title]:not([title=""])');
      if (anyTitle) groupName = anyTitle.getAttribute("title").trim();
    }

    // Find snippet / last message text
    let snippet = "";
    const msgEl = el.querySelector(
      '.conv-message, .conv-item__message, .truncate:not(.conv-item-title__name), .preview, [data-id="conv-message"]'
    );
    if (msgEl) {
      snippet = msgEl.textContent.trim();
    }

    // Find unread badge
    const badgeEl = el.querySelector(
      '.unread-badge, .v2-badge, .tab-red, .conv-item__unread, .badge, [class*="unread"], [class*="badge"]'
    );
    let unreadCount = 0;
    if (badgeEl) {
      const num = parseInt(badgeEl.textContent.trim(), 10);
      unreadCount = isNaN(num) ? 1 : num;
    }

    return { el, threadId, groupName, snippet, unreadCount };
  }

  // Process sidebar conversation list items
  function scanSidebarConversations() {
    // Selector covers current and future Zalo Web layout variations
    const convItems = document.querySelectorAll(
      'div[id^="conv-item-"], .conv-item, [data-id="conversation-item"], div[tabindex="0"][role="button"]'
    );

    if (convItems.length === 0) return;

    convItems.forEach((itemEl) => {
      const info = parseConversationItem(itemEl);
      if (!info || (!info.groupName && !info.threadId) || !info.snippet) return;

      const key = info.threadId || info.groupName;
      const prev = convState.get(key);

      // On first initial scan, just record current state to prevent forwarding old history
      if (!isInitialized) {
        convState.set(key, {
          snippet: info.snippet,
          unreadCount: info.unreadCount,
          time: Date.now()
        });
        return;
      }

      if (!prev) {
        // Newly appeared conversation
        convState.set(key, {
          snippet: info.snippet,
          unreadCount: info.unreadCount,
          time: Date.now()
        });

        // If it has unread badge right away, forward
        if (info.unreadCount > 0) {
          handleSidebarMessage(info);
        }
      } else {
        const hasNewUnread = info.unreadCount > prev.unreadCount;
        const hasSnippetChanged = info.snippet !== prev.snippet;

        convState.set(key, {
          snippet: info.snippet,
          unreadCount: info.unreadCount,
          time: Date.now()
        });

        if (hasNewUnread || (hasSnippetChanged && info.unreadCount > 0)) {
          handleSidebarMessage(info);
        }
      }
    });

    if (!isInitialized) {
      isInitialized = true;
      console.log(`[Zalo2Tele] ✅ Đã lưu trạng thái ban đầu của ${convState.size} hội thoại`);
    }
  }

  function handleSidebarMessage(info) {
    let sender = "Thành viên";
    let text = info.snippet;

    if (text.startsWith("Bạn:") || text.startsWith("Bạn :")) {
      return; // Do not forward messages sent by self
    }

    if (text.includes(": ")) {
      const idx = text.indexOf(": ");
      sender = text.slice(0, idx).trim();
      text = text.slice(idx + 2).trim();
    }

    dispatchMessage({
      threadId: info.threadId,
      groupName: info.groupName,
      sender: sender,
      text: text,
      source: "Sidebar"
    });
  }

  // 3. Scan Active Chat Area (Right pane)
  function setupActiveChatObserver() {
    const chatContainer = document.querySelector(
      '#chatViewContainer, .chat-message-list, .message-view, [data-id="chat-view"]'
    );

    if (!chatContainer) {
      setTimeout(setupActiveChatObserver, 2000);
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;

          // Check if node is a message element or contains message elements
          const msgNodes = node.matches('.chat-message, .bubble, [data-id="chat-message"]')
            ? [node]
            : Array.from(node.querySelectorAll('.chat-message, .bubble, [data-id="chat-message"]'));

          msgNodes.forEach((msgEl) => {
            // Skip messages sent by self
            if (
              msgEl.matches('.me, .chat-message--me, .bubble--me, [class*="--me"]') ||
              msgEl.querySelector('.me, .chat-message--me, .bubble--me')
            ) {
              return;
            }

            // Get current active chat title
            const headerTitleEl = document.querySelector(
              '#chatHeader .header-title, .chat-title, .chat-header-title, [data-id="chat-title"]'
            );
            const groupName = headerTitleEl ? headerTitleEl.textContent.trim() : "";

            // Get sender
            const senderEl = msgEl.querySelector(
              '.chat-message__sender-name, .sender-name, .author, [class*="sender"]'
            );
            const sender = senderEl ? senderEl.textContent.trim() : "Thành viên";

            // Get text
            const textEl = msgEl.querySelector(
              '.bubble-text, .msg-text, .message-text, .text-content, [class*="bubble"]'
            );
            const text = textEl ? textEl.textContent.trim() : msgEl.textContent.trim();

            if (groupName && text) {
              dispatchMessage({
                threadId: "",
                groupName,
                sender,
                text,
                source: "ActiveChat"
              });
            }
          });
        });
      });
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    console.log("[Zalo2Tele] ✅ Đã gắn observer theo dõi khung chat đang mở");
  }

  // 4. MutationObserver for conversation list changes
  function setupSidebarObserver() {
    const target = document.body;
    const observer = new MutationObserver(() => {
      scanSidebarConversations();
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });
    console.log("[Zalo2Tele] ✅ Đã gắn observer theo dõi danh sách hội thoại");
  }

  // Periodic polling fallback every 2.5 seconds
  setInterval(scanSidebarConversations, 2500);

  // Initialize
  setTimeout(() => {
    scanSidebarConversations();
    setupSidebarObserver();
    setupActiveChatObserver();
  }, 3000);
})();
