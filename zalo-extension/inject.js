// inject.js - Runs in page context (MAIN world) at document_start
(function () {
  console.log("[Zalo2Tele] Hooking window.Notification in page context...");

  if (typeof window.Notification !== "undefined") {
    const OriginalNotification = window.Notification;

    function CustomNotification(title, options) {
      try {
        window.postMessage(
          {
            type: "ZALO2TELE_NOTIFICATION",
            payload: {
              title: title || "",
              body: (options && options.body) || "",
              tag: (options && options.tag) || "",
              icon: (options && options.icon) || "",
              time: Date.now()
            }
          },
          "*"
        );
      } catch (err) {
        console.warn("[Zalo2Tele] Notification hook warning:", err);
      }
      return new OriginalNotification(title, options);
    }

    CustomNotification.prototype = OriginalNotification.prototype;
    Object.defineProperty(CustomNotification, "permission", {
      get() {
        return OriginalNotification.permission;
      }
    });

    if (typeof OriginalNotification.requestPermission === "function") {
      CustomNotification.requestPermission = OriginalNotification.requestPermission.bind(OriginalNotification);
    }

    window.Notification = CustomNotification;
  }
})();
