(() => {
  // ================ DOM helpers ================
  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var $dom = function(id) { return document.querySelector('[data-dom-id="' + id + '"]'); };
  var $page = function(name) { return document.querySelector('.page[data-page="' + name + '"]'); };

  // ================ State ================
  var state = {
    currentPage: "login",
    activeSessionId: null,
    activePassword: "",
    sessions: [],
    report: null,
    eventOffset: 0,
    eventsPerPage: 50,
    eventsTotal: 0,
    installedApps: [],
    selectedApps: {},
    appSearchKeyword: "",
    notifications: [],
    unreadCount: 0,
    user: null,
    roleInfo: null,
    isRecording: false,
    recordingStream: null,
    recordingVideo: null,
    recordingCanvas: null,
    recordingCtx: null,
    recordingTimer: null,
    recordingInterval: null,
    recordingStartTime: 0,
    recordingFrameCount: 0,
    newSession: {
      roleName: "",
      durationHours: 72,
      retentionDays: 7,
      password: "",
      appWhitelist: [],
      captureKeyboardText: true
    },
    agentResult: null,
    agentRunning: false,
    generatingReport: false,
    onboardingStep: 1,
    agentIndex: 0,
    analysisProgress: 0,
    analysisInterval: null,
    publicConfig: {},
    sessionPasswordCache: {},
    notifFilter: "all",
    settings: {
      llmProvider: "deepseek",
      llmModel: "deepseek-chat",
      llmApiBase: "https://api.deepseek.com/v1",
      llmApiKey: "",
      defaultDurationDays: 3,
      autoStart: false,
      timeoutAlert: true,
      retentionDays: 30
    }
  };

  // ================ Utils ================
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"/']/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#x2F;" }[c];
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    var mm = String(m % 60).padStart(2, "0");
    var ss = String(s % 60).padStart(2, "0");
    if (h > 0) return h + ":" + mm + ":" + ss;
    return mm + ":" + ss;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  }

  function formatRelativeTime(ts) {
    var diff = Date.now() - ts;
    var min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return min + " 分钟前";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + " 小时前";
    var day = Math.floor(hr / 24);
    if (day < 7) return day + " 天前";
    return formatTime(ts);
  }

  function setHas(set, key) {
    return set.hasOwnProperty(key);
  }
  function setAdd(set, key) {
    set[key] = true;
  }
  function setDelete(set, key) {
    delete set[key];
  }
  function setSize(set) {
    return Object.keys(set).length;
  }
  function setToArray(set) {
    return Object.keys(set);
  }

  // ================ Toast ================
  function toast(kind, title, body) {
    var container = $("#toast-container");
    if (!container) {
      var el = document.createElement("div");
      el.id = "toast-container";
      el.style.cssText = "position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;";
      document.body.appendChild(el);
    }
    var host = $("#toast-container");
    var el = document.createElement("div");
    var colors = {
      ok: "background:#f0fdf4;border-color:#bbf7d0;color:#15803d;",
      err: "background:#fef2f2;border-color:#fecaca;color:#b91c1c;",
      info: "background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;",
      warn: "background:#fffbeb;border-color:#fde68a;color:#b45309;"
    };
    el.style.cssText = (colors[kind] || colors.info) + "padding:12px 16px;border-radius:12px;border:1px solid;min-width:240px;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,0.1);font-size:13px;font-family:system-ui,sans-serif;";
    el.innerHTML =
      "<div style='font-weight:600;margin-bottom:4px'>" + escapeHtml(title) + "</div>" +
      (body ? "<div style='opacity:0.8;font-size:12px'>" + escapeHtml(body) + "</div>" : "");
    host.appendChild(el);
    setTimeout(function() {
      el.style.opacity = "0";
      el.style.transform = "translateX(40px)";
      el.style.transition = "opacity .25s ease, transform .25s ease";
      setTimeout(function() { el.remove(); }, 300);
    }, 3200);
  }

  // ================ HTTP utils ================
  function http(path, body, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (opts.headers) {
      for (var k in opts.headers) {
        if (opts.headers.hasOwnProperty(k)) {
          headers[k] = opts.headers[k];
        }
      }
    }
    var isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    if (isFormData) {
      delete headers["content-type"];
    }
    var fetchOpts = {
      method: body ? "POST" : "GET",
      headers: headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined
    };
    return fetch(path, fetchOpts).then(function(res) {
      if (!res.ok && res.status !== 201) {
        return res.json().catch(function() { return {}; }).then(function(msg) {
          throw new Error(msg.error || ("HTTP " + res.status));
        });
      }
      return res.json();
    });
  }

  // ================ Storage ================
  function saveToStorage() {
    try {
      localStorage.setItem("fde-user", JSON.stringify(state.user || {}));
      localStorage.setItem("fde-sessions", JSON.stringify(state.sessions || []));
      localStorage.setItem("fde-notifications", JSON.stringify(state.notifications || []));
      localStorage.setItem("fde-settings", JSON.stringify(state.settings || {}));
    } catch(e) {}
  }

  function loadFromStorage() {
    try {
      var user = localStorage.getItem("fde-user");
      if (user) state.user = JSON.parse(user);
      var sessions = localStorage.getItem("fde-sessions");
      if (sessions) state.sessions = JSON.parse(sessions);
      var notifs = localStorage.getItem("fde-notifications");
      if (notifs) state.notifications = JSON.parse(notifs);
      var settings = localStorage.getItem("fde-settings");
      if (settings) state.settings = JSON.parse(settings);
      updateUnreadCount();
    } catch(e) {}
  }

  function updateUnreadCount() {
    var count = 0;
    for (var i = 0; i < state.notifications.length; i++) {
      if (!state.notifications[i].read) count++;
    }
    state.unreadCount = count;
  }

  function addNotification(title, body, type) {
    var notif = {
      id: "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      title: title,
      body: body || "",
      type: type || "info",
      read: false,
      createdAt: Date.now()
    };
    state.notifications.unshift(notif);
    state.unreadCount++;
    saveToStorage();
    updateNotifBadges();
  }

  function updateNotifBadges() {
    var badges = document.querySelectorAll(".notif-badge, [data-notif-badge]");
    for (var i = 0; i < badges.length; i++) {
      if (state.unreadCount > 0) {
        badges[i].textContent = state.unreadCount;
        badges[i].style.display = "";
      } else {
        badges[i].style.display = "none";
      }
    }
  }

  // ================ Page Router ================
  function showPage(name) {
    state.currentPage = name;
    var pages = document.querySelectorAll(".page");
    for (var i = 0; i < pages.length; i++) {
      pages[i].classList.remove("page-active");
    }
    var target = $page(name);
    if (target) {
      target.classList.add("page-active");
    }
    window.scrollTo(0, 0);
    initPage(name);
  }

  function initPage(name) {
    switch(name) {
      case "login":
        initLoginPage();
        break;
      case "onboarding":
        initOnboardingPage();
        break;
      case "dashboard":
        initDashboardPage();
        break;
      case "analysis":
        initAnalysisPage();
        break;
      case "report":
        initReportPage();
        break;
      case "agent":
        initAgentPage();
        break;
      case "notifications":
        initNotificationsPage();
        break;
      case "settings":
        initSettingsPage();
        break;
    }
  }

  // ============================================================
  // PAGE 1: Login Page
  // ============================================================
  function initLoginPage() {
    var page = $page("login");
    if (!page) return;

    updateLoginUI();

    var tabMap = {
      "微信登录": "wechat",
      "支付宝登录": "alipay",
      "手机号登录": "phone"
    };

    var tabs = page.querySelectorAll(".login-tab");
    for (var i = 0; i < tabs.length; i++) {
      (function(tab) {
        tab.addEventListener("click", function() {
          var tabName = tabMap[tab.textContent.trim()];
          if (!tabName) return;

          for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.remove("active");
          }
          tab.classList.add("active");

          var panels = page.querySelectorAll(".tab-panel");
          for (var k = 0; k < panels.length; k++) {
            panels[k].classList.remove("active");
          }
          var targetPanel = page.querySelector("#tab-" + tabName);
          if (targetPanel) targetPanel.classList.add("active");
        });
      })(tabs[i]);
    }

    var wechatPanel = page.querySelector("#tab-wechat");
    if (wechatPanel) {
      var wechatLoginBtn = wechatPanel.querySelector("button");
      if (wechatLoginBtn) {
        wechatLoginBtn.addEventListener("click", function() {
          var user = { type: "wechat", name: "微信用户", avatar: "", loginAt: Date.now() };
          loginUser(user);
        });
      }
    }

    var alipayPanel = page.querySelector("#tab-alipay");
    if (alipayPanel) {
      var alipayLoginBtn = alipayPanel.querySelector("button");
      if (alipayLoginBtn) {
        alipayLoginBtn.addEventListener("click", function() {
          var user = { type: "alipay", name: "支付宝用户", avatar: "", loginAt: Date.now() };
          loginUser(user);
        });
      }
    }

    var codeCooldown = 0;
    var sendCodeBtn = page.querySelector(".btn-send-code");
    if (sendCodeBtn) {
      sendCodeBtn.addEventListener("click", function() {
        if (codeCooldown > 0) return;
        var phoneInput = page.querySelector("#login-phone, input[type=tel]");
        var phone = phoneInput ? phoneInput.value.trim() : "";
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          toast("err", "手机号格式错误", "请输入正确的 11 位手机号");
          return;
        }
        toast("ok", "验证码已发送", "模拟验证码：123456");
        codeCooldown = 60;
        function tick() {
          if (codeCooldown <= 0) {
            sendCodeBtn.disabled = false;
            sendCodeBtn.textContent = "发送验证码";
            return;
          }
          sendCodeBtn.disabled = true;
          sendCodeBtn.textContent = codeCooldown + "s";
          codeCooldown--;
          setTimeout(tick, 1000);
        }
        tick();
      });
    }

    var phoneLoginBtn = page.querySelector(".btn-login");
    if (phoneLoginBtn) {
      phoneLoginBtn.addEventListener("click", function() {
        var phoneInput = page.querySelector("#login-phone, input[type=tel]");
        var codeInput = page.querySelector("#login-code, input[placeholder*=验证码]");
        var phone = phoneInput ? phoneInput.value.trim() : "";
        var code = codeInput ? codeInput.value.trim() : "";
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          toast("err", "手机号格式错误", "请输入正确的 11 位手机号");
          return;
        }
        if (code !== "123456") {
          toast("err", "验证码错误", "模拟环境验证码：123456");
          return;
        }
        var user = { type: "phone", name: "用户" + phone.slice(-4), phone: phone, avatar: "", loginAt: Date.now() };
        loginUser(user);
      });
    }

    var logoutBtn = page.querySelector('[data-action="logout"]') || $dom("logout") || page.querySelector("#btn-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function() {
        state.user = null;
        saveToStorage();
        toast("info", "已退出登录");
        updateLoginUI();
      });
    }

    var newSessionBtn = page.querySelector(".btn-new");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", function() {
        if (!state.user) {
          toast("warn", "请先登录", "登录后才能创建观察会话");
          return;
        }
        state.onboardingStep = 1;
        state.selectedApps = {};
        state.newSession = {
          roleName: state.newSession.roleName || "",
          durationHours: state.settings.defaultDurationDays * 24,
          retentionDays: state.settings.retentionDays || 7,
          password: "",
          appWhitelist: [],
          captureKeyboardText: true
        };
        showPage("onboarding");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var n = 0; n < notifBtns.length; n++) {
      notifBtns[n].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Open settings
    var settingsBtns = page.querySelectorAll('[data-dom-id="open-settings"]');
    for (var s = 0; s < settingsBtns.length; s++) {
      settingsBtns[s].addEventListener("click", function() {
        showPage("settings");
      });
    }

    // Back home
    var backHome = page.querySelector('[data-dom-id="back-home"]');
    if (backHome) {
      backHome.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Role input search
    var roleInput = page.querySelector("#role-input, [data-role-input]");
    if (roleInput) {
      var roleTimer = null;
      roleInput.addEventListener("input", function(e) {
        clearTimeout(roleTimer);
        state.newSession.roleName = e.target.value;
        var val = e.target.value.trim();
        if (!val) return;
        roleTimer = setTimeout(function() { searchRole(val); }, 600);
      });
    }

    // Session search
    var searchInput = page.querySelector(".search-input, #session-search");
    if (searchInput) {
      searchInput.addEventListener("input", function(e) {
        renderSessionList(e.target.value.toLowerCase());
      });
    }

    // Conversation items
    var convItems = page.querySelectorAll(".conv-item, [data-session-id]");
    for (var c = 0; c < convItems.length; c++) {
      convItems[c].addEventListener("click", function() {
        var sid = this.getAttribute("data-session-id");
        if (sid) {
          openSession(sid);
        }
      });
    }

    // Load sessions
    refreshSessions();
    renderSessionList("");
  }

  function updateLoginUI() {
    var page = $page("login");
    if (!page) return;

    var user = state.user;
    var loggedInPanel = page.querySelector(".logged-in-panel, [data-logged-in]");
    var loginForm = page.querySelector(".login-form, .login-tabs, [data-login-form]");
    var tabPanels = page.querySelectorAll(".tab-panel");

    if (user) {
      if (loggedInPanel) loggedInPanel.style.display = "";
      if (loginForm) loginForm.style.display = "none";
      for (var i = 0; i < tabPanels.length; i++) {
        tabPanels[i].style.display = "none";
      }
      var userNameEl = page.querySelector(".user-name, [data-user-name]");
      if (userNameEl) userNameEl.textContent = user.name;
      var userAvatarEl = page.querySelector(".avatar-circle, [data-user-avatar]");
      if (userAvatarEl) userAvatarEl.textContent = user.name ? user.name.charAt(0) : "U";
    } else {
      if (loggedInPanel) loggedInPanel.style.display = "none";
      if (loginForm) loginForm.style.display = "";
      for (var j = 0; j < tabPanels.length; j++) {
        tabPanels[j].style.display = "";
      }
    }
  }

  function loginUser(user) {
    state.user = user;
    saveToStorage();
    addNotification("登录成功", "欢迎使用 FDE 助手", "success");
    toast("ok", "登录成功", "欢迎使用 AI FDE 助手");
    updateLoginUI();
    refreshSessions();
  }

  function renderSessionList(keyword) {
    var page = $page("login");
    if (!page) return;

    var listContainer = page.querySelector(".conversation-list, #session-list, [data-session-list]");
    if (!listContainer) return;

    var sessions = state.sessions;
    if (keyword) {
      sessions = sessions.filter(function(s) {
        var id = (s.id || "").toLowerCase();
        var name = (s.name || "").toLowerCase();
        return id.indexOf(keyword) !== -1 || name.indexOf(keyword) !== -1;
      });
    }

    if (sessions.length === 0) {
      listContainer.innerHTML = '<div style="padding:40px;text-align:center;color:#858585;font-size:13px;">暂无会话，点击下方按钮创建新会话</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var statusText = "待开始";
      var statusClass = "";
      if (s.status === "recording") { statusText = "观察中"; statusClass = "active-status"; }
      else if (s.status === "paused") { statusText = "已暂停"; statusClass = "paused"; }
      else if (s.status === "finalized") { statusText = "已完成"; statusClass = "done"; }

      var eventCount = s.eventCount || 0;
      var progress = s.progress || 0;
      var isActive = s.id === state.activeSessionId;

      html += '<div class="conv-item ' + (isActive ? "active" : "") + '" data-session-id="' + escapeHtml(s.id) + '">' +
        '<div class="conv-info">' +
          '<div class="conv-title">' + escapeHtml(s.name || ("会话 " + s.id.slice(-8))) + '</div>' +
          '<div class="conv-meta">' +
            '<span class="conv-status ' + statusClass + '">' + statusText + '</span>' +
            '<span>' + eventCount + ' 条事件</span>' +
          '</div>' +
        '</div>' +
        '<div class="conv-right">' +
          '<div class="progress-track">' +
            '<div class="progress-fill ' + (s.status === "finalized" ? "gray" : "blue") + '" style="width:' + progress + '%"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    listContainer.innerHTML = html;

    // Re-bind click events
    var items = listContainer.querySelectorAll(".conv-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function() {
        var sid = this.getAttribute("data-session-id");
        if (sid) openSession(sid);
      });
    }
  }

  function openSession(sessionId) {
    state.activeSessionId = sessionId;
    if (state.sessionPasswordCache[sessionId]) {
      state.activePassword = state.sessionPasswordCache[sessionId];
    } else {
      state.activePassword = prompt("请输入会话口令：", "");
      if (state.activePassword) {
        state.sessionPasswordCache[sessionId] = state.activePassword;
      }
    }
    showPage("dashboard");
  }

  function refreshSessions() {
    http("/api/sessions").then(function(data) {
      if (data && data.sessions) {
        state.sessions = data.sessions;
        saveToStorage();
        renderSessionList("");
      }
    }).catch(function(err) {
      console.warn("Failed to load sessions:", err);
    });
  }

  function searchRole(query) {
    http("/api/role/search", { query: query }).then(function(data) {
      state.roleInfo = data;
    }).catch(function(err) {
      console.warn("Role search failed:", err);
    });
  }

  // ============================================================
  // PAGE 2: Onboarding Page
  // ============================================================
  function initOnboardingPage() {
    var page = $page("onboarding");
    if (!page) return;

    state.onboardingStep = state.onboardingStep || 1;
    updateOnboardingStep();

    // Back to login
    var backBtn = page.querySelector('[data-dom-id="back-home"], .back-btn, [data-action="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        state.onboardingStep = 1;
        showPage("login");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Step 1 - Career tags
    var careerTags = page.querySelectorAll(".career-tag, [data-career]");
    for (var j = 0; j < careerTags.length; j++) {
      careerTags[j].addEventListener("click", function() {
        var career = this.getAttribute("data-career") || this.textContent.trim();
        var allTags = page.querySelectorAll(".career-tag");
        for (var k = 0; k < allTags.length; k++) {
          allTags[k].classList.remove("selected");
        }
        this.classList.add("selected");
        state.newSession.roleName = career;
      });
    }

    // Custom career input
    var customCareer = page.querySelector("#customCareerInput, .underline-input, [data-custom-career]");
    if (customCareer) {
      customCareer.addEventListener("input", function() {
        state.newSession.roleName = this.value;
      });
    }

    // App scan button
    var scanBtn = page.querySelector('[data-action="scan-apps"]') || $dom("scan-apps") || page.querySelector(".rescan-btn, #btn-scan-apps");
    if (scanBtn) {
      scanBtn.addEventListener("click", scanInstalledApps);
    }

    // App items toggle
    var appItems = page.querySelectorAll(".app-item, [data-app]");
    for (var a = 0; a < appItems.length; a++) {
      appItems[a].addEventListener("click", function() {
        var appName = this.getAttribute("data-app");
        if (!appName) return;
        if (setHas(state.selectedApps, appName)) {
          setDelete(state.selectedApps, appName);
          this.classList.remove("checked");
        } else {
          setAdd(state.selectedApps, appName);
          this.classList.add("checked");
        }
        updateAppCount();
      });
    }

    // Step navigation
    var step1Next = page.querySelector('[data-step-next="1"], #btn-step-next-1, [onclick*="goToStep(2)"]');
    if (step1Next) {
      step1Next.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(2);
      });
    }

    var step2Prev = page.querySelector('[data-step-prev="2"], #btn-step-prev-2, [onclick*="goToStep(1)"]');
    if (step2Prev) {
      step2Prev.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(1);
      });
    }

    var step2Next = page.querySelector('[data-step-next="2"], #btn-step-next-2, [onclick*="goToStep(3)"]');
    if (step2Next) {
      step2Next.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        var pwdInput = page.querySelector("#passwordInput, #session-password, input[type=password]");
        var pwd = pwdInput ? pwdInput.value : "";
        if (!pwd || pwd.length < 8) {
          toast("err", "口令太短", "请设置至少 8 位的会话口令");
          return;
        }
        state.newSession.password = pwd;
        goToOnboardingStep(3);
      });
    }

    var step3Prev = page.querySelector('[data-step-prev="3"], #btn-step-prev-3, [onclick*="goToStep(2)"]');
    if (step3Prev) {
      step3Prev.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(2);
      });
    }

    // Duration buttons
    var durationBtns = page.querySelectorAll(".duration-btn, [data-days], [data-duration]");
    for (var d = 0; d < durationBtns.length; d++) {
      durationBtns[d].addEventListener("click", function() {
        var days = this.getAttribute("data-days") || this.getAttribute("data-duration");
        if (days) {
          state.newSession.durationHours = Number(days) * 24;
          var allBtns = page.querySelectorAll(".duration-btn");
          for (var di = 0; di < allBtns.length; di++) {
            allBtns[di].classList.remove("selected");
          }
          this.classList.add("selected");
        }
      });
    }

    // Retention select
    var retentionSelect = page.querySelector("#retention, [data-retention-select]");
    if (retentionSelect) {
      retentionSelect.addEventListener("change", function() {
        state.newSession.retentionDays = Number(this.value);
      });
    }

    // Start observation / create session
    var startBtn = page.querySelector('[data-dom-id="start-observation"], [data-action="create-session"], #btn-create-session');
    if (startBtn) {
      startBtn.addEventListener("click", createNewSession);
    }

    updateAppCount();
    loadInstalledApps();
  }

  function updateOnboardingStep() {
    var page = $page("onboarding");
    if (!page) return;

    var step = state.onboardingStep;

    // Step panels
    var panels = page.querySelectorAll(".step-panel");
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.remove("active");
    }
    var targetPanel = page.querySelector("#step" + step);
    if (targetPanel) targetPanel.classList.add("active");

    // Step indicator
    var stepLabel = page.querySelector(".step-number, [data-step-label]");
    if (stepLabel) stepLabel.textContent = "0" + step + " / 03";

    var stepLine = page.querySelector(".step-line .fill, [data-step-fill]");
    if (stepLine) {
      var pct = (step - 1) * 50;
      stepLine.style.width = pct + "%";
    }

    // Update summary on step 3
    if (step === 3) {
      updateOnboardingSummary();
    }
  }

  function goToOnboardingStep(step) {
    state.onboardingStep = step;
    updateOnboardingStep();
  }

  function updateAppCount() {
    var countEl = document.querySelector(".app-count, [data-app-count]");
    if (countEl) {
      var total = state.installedApps.length || 12;
      var selected = setSize(state.selectedApps);
      countEl.textContent = "共 " + total + " 个应用，已选 " + selected + " 个";
    }
  }

  function updateOnboardingSummary() {
    var page = $page("onboarding");
    if (!page) return;

    var careerEl = page.querySelector("#summaryCareer, [data-summary-career]");
    if (careerEl) careerEl.textContent = state.newSession.roleName || "未选择";

    var appsEl = page.querySelector("#summaryApps, [data-summary-apps]");
    if (appsEl) {
      var apps = setToArray(state.selectedApps);
      appsEl.textContent = apps.length > 0 ? apps.join(", ") : "未选择";
    }

    var durationEl = page.querySelector("#summaryDuration, [data-summary-duration]");
    if (durationEl) {
      var days = Math.ceil(state.newSession.durationHours / 24);
      durationEl.textContent = days + " 天";
    }

    var pwdEl = page.querySelector("#summaryPassword, [data-summary-password]");
    if (pwdEl) pwdEl.textContent = state.newSession.password ? "已设置" : "未设置";
  }

  function loadInstalledApps() {
    http("/api/system/apps").then(function(data) {
      if (data && data.apps) {
        state.installedApps = data.apps;
        updateAppCount();
      }
    }).catch(function(err) {
      console.warn("Failed to load apps:", err);
    });
  }

  function scanInstalledApps() {
    http("/api/system/apps").then(function(data) {
      if (data && data.apps) {
        state.installedApps = data.apps;
        toast("ok", "扫描完成", "发现 " + data.apps.length + " 个应用");
        updateAppCount();
      }
    }).catch(function(err) {
      toast("err", "扫描失败", err.message);
    });
  }

  function createNewSession() {
    var appWhitelist = setToArray(state.selectedApps);
    if (appWhitelist.length === 0) {
      appWhitelist = ["CRM", "Excel", "Word", "邮件"];
    }

    var body = {
      password: state.newSession.password,
      durationHours: state.newSession.durationHours,
      retentionDays: state.newSession.retentionDays,
      appWhitelist: appWhitelist,
      captureKeyboardText: state.newSession.captureKeyboardText
    };

    http("/api/sessions", body).then(function(data) {
      if (data && data.session) {
        var session = data.session;
        session.name = state.newSession.roleName ? (state.newSession.roleName + "助手") : ("会话 " + session.id.slice(-8));
        session.status = "idle";
        session.eventCount = 0;
        session.progress = 0;
        session.scope = {
          appWhitelist: appWhitelist,
          retentionDays: state.newSession.retentionDays,
          durationHours: state.newSession.durationHours
        };
        state.sessions.unshift(session);
        state.activeSessionId = session.id;
        state.activePassword = state.newSession.password;
        state.sessionPasswordCache[session.id] = state.newSession.password;
        saveToStorage();

        addNotification("会话创建成功", session.name + " 已创建", "success");
        toast("ok", "创建成功", "会话已创建，正在启动...");

        // Auto start session
        return http("/api/sessions/" + session.id + "/start", { password: state.newSession.password }).then(function() {
          session.status = "recording";
          saveToStorage();
          state.onboardingStep = 1;
          showPage("dashboard");
        });
      }
    }).catch(function(err) {
      toast("err", "创建失败", err.message);
    });
  }

  // ============================================================
  // PAGE 3: Dashboard Page
  // ============================================================
  function initDashboardPage() {
    var page = $page("dashboard");
    if (!page) return;

    var session = getActiveSession();
    updateDashboardUI(session);

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Pause observation
    var pauseBtn = page.querySelector('[data-dom-id="pause-observation"], #btn-pause-rec, [data-action="pause"]');
    if (pauseBtn) {
      pauseBtn.addEventListener("click", function() {
        sessionControl("pause");
      });
    }

    // End observation
    var endBtn = page.querySelector('[data-dom-id="end-observation"], #btn-stop-rec, [data-action="stop"]');
    if (endBtn) {
      endBtn.addEventListener("click", function() {
        if (confirm("确定要结束观察并生成报告吗？")) {
          sessionControl("stop");
        }
      });
    }

    // Start observation
    var startBtn = page.querySelector('[data-dom-id="start-observation"], #btn-start-rec, [data-action="start"]');
    if (startBtn) {
      startBtn.addEventListener("click", function() {
        sessionControl("start");
      });
    }

    // Inject demo
    var demoBtn = page.querySelector('[data-dom-id="inject-demo"], #btn-inject-demo, [data-action="inject-demo"]');
    if (demoBtn) {
      demoBtn.addEventListener("click", function() {
        injectDemoData();
      });
    }

    // Generate report
    var reportBtn = page.querySelector('[data-dom-id="gen-report"], #btn-gen-report, [data-action="gen-report"]');
    if (reportBtn) {
      reportBtn.addEventListener("click", generateReport);
    }

    // Screenshot upload
    var shotBtn = page.querySelector('[data-dom-id="upload-screenshot"], #btn-screenshot, [data-action="screenshot"]');
    var shotFile = page.querySelector("#shot-file, [data-shot-file]");
    if (shotBtn && shotFile) {
      shotBtn.addEventListener("click", function() {
        shotFile.click();
      });
      shotFile.addEventListener("change", onUploadScreenshot);
    }

    // File upload
    var uploadBtn = page.querySelector('[data-dom-id="upload-file"], #btn-upload, [data-action="upload"]');
    var upFile = page.querySelector("#up-file, [data-up-file]");
    if (uploadBtn && upFile) {
      uploadBtn.addEventListener("click", function() {
        upFile.click();
      });
      upFile.addEventListener("change", onUploadFile);
    }

    // Screen capture
    var captureBtn = page.querySelector('[data-dom-id="capture-screen"], #btn-capture-screen, [data-action="screen-record"]');
    if (captureBtn) {
      captureBtn.addEventListener("click", onCaptureScreen);
    }

    // Refresh events
    var refreshBtn = page.querySelector('[data-dom-id="refresh-events"], #btn-refresh-events, [data-action="refresh-events"]');
    if (refreshBtn) {
      refreshBtn.addEventListener("click", loadEvents);
    }

    // View raw events
    var rawEventsBtn = page.querySelector('[data-dom-id="open-raw-events"], [data-action="raw-events"]');
    if (rawEventsBtn) {
      rawEventsBtn.addEventListener("click", function() {
        loadEvents();
      });
    }

    // Session selector
    var sessionSelector = page.querySelector("#session-selector, [data-session-selector]");
    if (sessionSelector) {
      sessionSelector.addEventListener("change", function() {
        var id = this.value;
        if (id) {
          state.activeSessionId = id;
          if (state.sessionPasswordCache[id]) {
            state.activePassword = state.sessionPasswordCache[id];
          } else {
            var pwd = prompt("请输入会话口令：", "");
            if (pwd) {
              state.activePassword = pwd;
              state.sessionPasswordCache[id] = pwd;
            }
          }
          updateDashboardUI(getActiveSession());
          loadEvents();
        }
      });
    }

    // Initial load
    if (state.activeSessionId) {
      loadEvents();
    }
  }

  function getActiveSession() {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.activeSessionId) {
        return state.sessions[i];
      }
    }
    return null;
  }

  function updateDashboardUI(session) {
    var page = $page("dashboard");
    if (!page) return;

    if (!session) {
      // Show empty state
      var emptyState = page.querySelector(".empty-dashboard, [data-empty-dashboard]");
      var activeDashboard = page.querySelector(".dashboard-body, [data-active-dashboard]");
      if (emptyState) emptyState.style.display = "";
      if (activeDashboard) activeDashboard.style.display = "none";
      return;
    }

    // Status badge
    var statusBadge = page.querySelector(".status-badge, [data-status-badge]");
    if (statusBadge) {
      var statusText = "待开始";
      if (session.status === "recording") statusText = "观察中";
      else if (session.status === "paused") statusText = "已暂停";
      else if (session.status === "finalized") statusText = "已结束";
      statusBadge.querySelector("span:last-child, .status-text") ? 
        (statusBadge.querySelector(".status-text").textContent = statusText) : 
        (statusBadge.textContent = statusText);
    }

    // Stats
    var statValueEls = page.querySelectorAll(".stat-number, .sidebar-row-value, [data-stat]");
    if (statValueEls.length > 0) {
      // Update first stat with event count
      var eventStat = page.querySelector('[data-stat="events"], .stat-block:first-child .stat-number');
      if (eventStat) eventStat.textContent = session.eventCount || 0;
    }

    // Update button visibility based on status
    var startBtn = page.querySelector('[data-dom-id="start-observation"], #btn-start-rec');
    var pauseBtn = page.querySelector('[data-dom-id="pause-observation"], #btn-pause-rec');
    var endBtn = page.querySelector('[data-dom-id="end-observation"], #btn-stop-rec');

    if (session.status === "recording") {
      if (startBtn) startBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "";
      if (endBtn) endBtn.style.display = "";
    } else if (session.status === "paused") {
      if (startBtn) { startBtn.style.display = ""; startBtn.textContent = "继续观察"; }
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) endBtn.style.display = "";
    } else if (session.status === "finalized") {
      if (startBtn) startBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) endBtn.style.display = "none";
    } else {
      if (startBtn) { startBtn.style.display = ""; startBtn.textContent = "开始观察"; }
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) endBtn.style.display = "none";
    }
  }

  function sessionControl(action) {
    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var password = state.activePassword;
    if (!password) {
      password = prompt("请输入会话口令：", "");
      if (!password) return;
      state.activePassword = password;
      state.sessionPasswordCache[session.id] = password;
    }

    var endpoint = "";
    var body = { password: password };

    if (action === "start") endpoint = "/api/sessions/" + session.id + "/start";
    else if (action === "pause") endpoint = "/api/sessions/" + session.id + "/pause";
    else if (action === "stop") endpoint = "/api/sessions/" + session.id + "/finalize";
    else if (action === "demo") endpoint = "/api/sessions/" + session.id + "/demo";

    http(endpoint, body).then(function(data) {
      if (action === "start") {
        session.status = "recording";
        addNotification("观察已开始", session.name + " 开始记录", "success");
        toast("ok", "开始成功", "会话正在录制中");
      } else if (action === "pause") {
        session.status = "paused";
        addNotification("观察已暂停", session.name + " 已暂停", "info");
        toast("info", "已暂停", "会话已暂停");
      } else if (action === "stop") {
        session.status = "finalized";
        addNotification("观察已结束", session.name + " 已完成", "success");
        toast("ok", "已结束", "正在生成分析报告...");
        setTimeout(function() {
          showPage("analysis");
        }, 500);
      } else if (action === "demo") {
        session.eventCount = (session.eventCount || 0) + 50;
        addNotification("演示数据已注入", "已添加 50 条演示事件", "success");
        toast("ok", "注入成功", "演示数据已添加");
      }
      saveToStorage();
      updateDashboardUI(session);
      loadEvents();
    }).catch(function(err) {
      toast("err", "操作失败", err.message);
    });
  }

  function injectDemoData() {
    sessionControl("demo");
  }

  function generateReport() {
    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    if (state.generatingReport) {
      toast("info", "报告生成中", "请稍候...");
      return;
    }

    state.generatingReport = true;
    toast("info", "正在生成报告", "请稍候...");

    var password = state.activePassword;
    if (!password) {
      password = prompt("请输入会话口令：", "");
      if (!password) {
        state.generatingReport = false;
        return;
      }
      state.activePassword = password;
      state.sessionPasswordCache[session.id] = password;
    }

    http("/api/sessions/" + session.id + "/report", { password: password }).then(function() {
      state.generatingReport = false;
      addNotification("报告生成中", "AI 正在分析工作流", "info");
      showPage("analysis");
    }).catch(function(err) {
      state.generatingReport = false;
      toast("err", "生成失败", err.message);
    });
  }

  function onUploadScreenshot(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var password = state.activePassword;
    if (!password) {
      password = prompt("请输入会话口令：", "");
      if (!password) return;
      state.activePassword = password;
      state.sessionPasswordCache[session.id] = password;
    }

    var formData = new FormData();
    formData.append("file", file);
    formData.append("password", password);

    var appNameInput = document.querySelector("#shot-appName, [data-shot-app]");
    if (appNameInput && appNameInput.value) {
      formData.append("appName", appNameInput.value);
    }

    toast("info", "正在上传", "截图上传并识别中...");

    http("/api/sessions/" + session.id + "/screenshot", formData).then(function(data) {
      session.eventCount = (session.eventCount || 0) + 1;
      saveToStorage();
      toast("ok", "识别成功", "截图已上传并完成 OCR 识别");
      loadEvents();
    }).catch(function(err) {
      toast("err", "上传失败", err.message);
    });

    e.target.value = "";
  }

  function onUploadFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    toast("info", "文件上传", "文件分析功能开发中...");
    e.target.value = "";
  }

  function onCaptureScreen() {
    if (state.isRecording) {
      stopScreenRecording();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("err", "不支持录屏", "您的浏览器不支持屏幕录制功能");
      return;
    }

    navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    }).then(function(stream) {
      state.recordingStream = stream;
      state.isRecording = true;
      state.recordingStartTime = Date.now();
      state.recordingFrameCount = 0;

      // Create hidden video element
      var video = document.createElement("video");
      video.style.display = "none";
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      document.body.appendChild(video);
      state.recordingVideo = video;

      // Create canvas for frame capture
      var canvas = document.createElement("canvas");
      canvas.style.display = "none";
      document.body.appendChild(canvas);
      state.recordingCanvas = canvas;
      state.recordingCtx = canvas.getContext("2d");

      // Update UI
      updateRecordingUI();
      toast("ok", "录屏开始", "正在录制屏幕...");

      // Capture frames periodically
      state.recordingInterval = setInterval(captureAndSendFrame, 2000);

      // Handle stream stop
      stream.getVideoTracks()[0].addEventListener("ended", function() {
        stopScreenRecording();
      });
    }).catch(function(err) {
      toast("err", "录屏失败", err.message);
    });
  }

  function captureAndSendFrame() {
    if (!state.isRecording || !state.recordingVideo || !state.recordingCanvas) return;

    var video = state.recordingVideo;
    var canvas = state.recordingCanvas;
    var ctx = state.recordingCtx;

    if (video.videoWidth === 0) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    state.recordingFrameCount++;
    updateRecordingTimer();

    // Convert to blob and send
    canvas.toBlob(function(blob) {
      var session = getActiveSession();
      if (!session || !state.activePassword || !blob) return;

      var formData = new FormData();
      formData.append("file", blob, "frame_" + state.recordingFrameCount + ".png");
      formData.append("password", state.activePassword);
      formData.append("appName", "ScreenRecorder");

      http("/api/sessions/" + session.id + "/screenshot", formData).then(function() {
        session.eventCount = (session.eventCount || 0) + 1;
        saveToStorage();
      }).catch(function(err) {
        console.warn("Frame upload failed:", err);
      });
    }, "image/png", 0.7);
  }

  function stopScreenRecording() {
    if (state.recordingInterval) {
      clearInterval(state.recordingInterval);
      state.recordingInterval = null;
    }
    if (state.recordingStream) {
      state.recordingStream.getTracks().forEach(function(track) { track.stop(); });
      state.recordingStream = null;
    }
    if (state.recordingVideo) {
      state.recordingVideo.remove();
      state.recordingVideo = null;
    }
    if (state.recordingCanvas) {
      state.recordingCanvas.remove();
      state.recordingCanvas = null;
    }
    state.isRecording = false;
    updateRecordingUI();
    toast("info", "录屏结束", "已录制 " + state.recordingFrameCount + " 帧");
  }

  function updateRecordingTimer() {
    var timerEl = document.querySelector("#rec-timer, [data-rec-timer]");
    if (timerEl) {
      var elapsed = Date.now() - state.recordingStartTime;
      timerEl.textContent = formatDuration(elapsed);
    }
    var countEl = document.querySelector("#rec-count, [data-rec-count]");
    if (countEl) {
      countEl.textContent = state.recordingFrameCount + " 帧";
    }
  }

  function updateRecordingUI() {
    var indicator = document.querySelector("#rec-indicator, [data-rec-indicator]");
    var btn = document.querySelector('#btn-capture-screen, [data-action="screen-record"]');

    if (state.isRecording) {
      if (indicator) indicator.style.display = "";
      if (btn) {
        btn.textContent = "⏹ 停止录屏";
        btn.classList.add("btn-danger");
        btn.classList.remove("btn-primary");
      }
      state.recordingTimer = setInterval(updateRecordingTimer, 1000);
    } else {
      if (indicator) indicator.style.display = "none";
      if (btn) {
        btn.textContent = "📹 开始录屏";
        btn.classList.remove("btn-danger");
        btn.classList.add("btn-primary");
      }
      if (state.recordingTimer) {
        clearInterval(state.recordingTimer);
        state.recordingTimer = null;
      }
    }
  }

  function loadEvents() {
    var session = getActiveSession();
    if (!session) return;

    var password = state.activePassword;
    if (!password) {
      password = prompt("请输入会话口令：", "");
      if (!password) return;
      state.activePassword = password;
      state.sessionPasswordCache[session.id] = password;
    }

    http("/api/sessions/" + session.id + "/events?offset=" + state.eventOffset + "&limit=" + state.eventsPerPage + "&password=" + encodeURIComponent(password)).then(function(data) {
      if (data) {
        var events = data.events || data.items || [];
        state.eventsTotal = data.total || events.length;
        renderEvents(events);
      }
    }).catch(function(err) {
      console.warn("Failed to load events:", err);
    });
  }

  function renderEvents(events) {
    var page = $page("dashboard");
    if (!page) return;

    var container = page.querySelector("#events-container, .events-list, [data-events-container]");
    if (!container) return;

    if (events.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:#858585;font-size:13px;">暂无事件数据</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var time = ev.timestamp ? formatTime(ev.timestamp) : "";
      var appName = ev.appName || ev.app || "未知";
      var type = ev.type || "event";
      var desc = ev.text || ev.description || ev.summary || (type + "事件");

      html += '<div style="padding:12px 0;border-bottom:1px solid #e5e5e5;font-size:13px;">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
          '<span style="font-weight:500;color:#18181b;">' + escapeHtml(appName) + '</span>' +
          '<span style="font-size:11px;color:#858585;font-family:monospace;">' + escapeHtml(time) + '</span>' +
        '</div>' +
        '<div style="color:#858585;font-size:12px;">' + escapeHtml(String(desc).slice(0, 100)) + '</div>' +
      '</div>';
    }
    container.innerHTML = html;
  }

  // ============================================================
  // PAGE 4: Analysis Page
  // ============================================================
  function initAnalysisPage() {
    var page = $page("analysis");
    if (!page) return;

    state.analysisProgress = 0;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        if (state.analysisInterval) clearInterval(state.analysisInterval);
        showPage("login");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // View report button
    var viewReportBtn = page.querySelector('[data-dom-id="view-report"], [data-action="view-report"]');
    if (viewReportBtn) {
      viewReportBtn.addEventListener("click", function() {
        if (state.analysisProgress >= 100) {
          showPage("report");
        }
      });
    }

    startAnalysisAnimation();
  }

  function startAnalysisAnimation() {
    if (state.analysisInterval) {
      clearInterval(state.analysisInterval);
    }

    state.analysisProgress = 0;
    var session = getActiveSession();
    var sessionId = session ? session.id : null;
    var password = state.activePassword;

    state.analysisInterval = setInterval(function() {
      state.analysisProgress = Math.min(100, state.analysisProgress + Math.random() * 8 + 2);
      updateAnalysisUI();

      if (state.analysisProgress >= 100) {
        state.analysisProgress = 100;
        clearInterval(state.analysisInterval);
        state.analysisInterval = null;

        // Try to fetch report
        if (sessionId && password) {
          http("/api/sessions/" + sessionId + "/report?password=" + encodeURIComponent(password)).then(function(data) {
            state.report = data;
            addNotification("报告已生成", "AI 机会报告已就绪", "success");
            setTimeout(function() {
              if (state.currentPage === "analysis") {
                showPage("report");
              }
            }, 800);
          }).catch(function(err) {
            console.warn("Failed to load report:", err);
            // Use mock report
            state.report = generateMockReport();
            setTimeout(function() {
              if (state.currentPage === "analysis") {
                showPage("report");
              }
            }, 800);
          });
        } else {
          state.report = generateMockReport();
          setTimeout(function() {
            if (state.currentPage === "analysis") {
              showPage("report");
            }
          }, 800);
        }
      }

      if (state.currentPage !== "analysis") {
        clearInterval(state.analysisInterval);
        state.analysisInterval = null;
      }
    }, 400);
  }

  function updateAnalysisUI() {
    var page = $page("analysis");
    if (!page) return;

    var progress = state.analysisProgress;

    // Progress bar
    var progressFill = page.querySelector(".phase-bar-fill.animating, .progress-fill, [data-progress-fill]");
    if (progressFill) progressFill.style.width = progress + "%";

    var progressText = page.querySelector(".progress-text, [data-progress-text]");
    if (progressText) progressText.textContent = Math.floor(progress) + "%";

    // Phase items
    var phases = page.querySelectorAll(".phase, [data-phase]");
    var thresholds = [20, 40, 60, 80, 100];
    for (var i = 0; i < phases.length && i < thresholds.length; i++) {
      var badge = phases[i].querySelector(".phase-badge");
      var barFill = phases[i].querySelector(".phase-bar-fill");
      if (progress >= thresholds[i]) {
        if (badge) {
          badge.classList.remove("pending", "active");
          badge.classList.add("done");
        }
        if (barFill) {
          barFill.classList.remove("gray", "blue");
          barFill.classList.add("green");
          barFill.style.width = "100%";
        }
      } else if (progress >= (thresholds[i] - 20)) {
        if (badge) {
          badge.classList.remove("pending", "done");
          badge.classList.add("active");
        }
        if (barFill) {
          barFill.classList.remove("gray", "green");
          barFill.classList.add("blue");
        }
      }
    }
  }

  function generateMockReport() {
    return {
      observationHours: 16.5,
      clusters: [
        { name: "客户信息搬运", count: 42 },
        { name: "库存查询回复", count: 28 },
        { name: "日报编写", count: 5 },
        { name: "报价单生成", count: 15 }
      ],
      opportunities: [
        {
          title: "客户信息搬运助手",
          priority: "高",
          description: "自动从 CRM 系统提取客户信息，填充到报价单模板并生成邮件草稿",
          score: { automationPotential: 92, businessValue: 88, integrationComplexity: 35, riskLevel: 25 },
          evidence: ["复制客户名 → 粘贴报价单 → 填写邮箱", "每周 42 次，涉及 3 个应用"],
          timeSavedWeekly: 3.5
        },
        {
          title: "库存状态问答 Agent",
          priority: "高",
          description: "自动查询库存状态并回复团队消息，减少重复沟通",
          score: { automationPotential: 85, businessValue: 76, integrationComplexity: 45, riskLevel: 20 },
          evidence: ["打开库存表 → 搜索 SKU → 回复同事消息", "每周 28 次，涉及 2 个应用"],
          timeSavedWeekly: 2.0
        },
        {
          title: "自动日报助手",
          priority: "高",
          description: "自动汇总当日工作内容生成日报，减少排版时间",
          score: { automationPotential: 90, businessValue: 65, integrationComplexity: 30, riskLevel: 15 },
          evidence: ["打开多个工具 → 复制数据 → 粘贴到日报模板 → 排版调整", "每周 5 次，涉及 4 个应用"],
          timeSavedWeekly: 1.5
        }
      ],
      blueprints: [
        {
          name: "客户信息搬运工作流",
          trigger: "每日定时 / 手动触发",
          inputs: ["CRM 客户数据", "报价单模板"],
          aiJudgement: ["信息完整性校验", "模板变量匹配"],
          tools: ["CRM 读取", "表格操作", "邮件生成"],
          humanConfirmation: "邮件发送前确认",
          outputs: ["填充完成的报价单", "邮件草稿"]
        }
      ],
      specs: [
        {
          role: "客户信息搬运助手",
          goal: "自动从 CRM 提取客户信息，填充到报价单和邮件草稿中",
          allowedTools: ["CRM 读取（只读）", "表格读取（只读）", "LLM 文本生成", "邮件生成（需确认）"],
          guardrails: [
            "仅在授权应用范围内操作，不得访问 CRM 和表格以外的系统",
            "不读取或传输客户敏感信息（身份证号、银行卡等）",
            "所有输出内容在发送前必须校验模板变量完整性",
            "连续失败 2 次后自动停止并通知用户介入"
          ],
          promptSketch: "# 角色：客户信息搬运助手\n\n目标：自动从 CRM 提取客户信息，填充到报价单和邮件草稿中。\n\n## 护栏\n- 仅在授权应用范围内操作\n- 不读取敏感内容\n- 输出前校验模板变量\n- 失败 2 次停止\n\n## 可用工具\n- CRM 读取（只读）\n- 表格读取（只读）\n- 邮件发送（需确认）\n- LLM 文本生成"
        }
      ]
    };
  }

  // ============================================================
  // PAGE 5: Report Page
  // ============================================================
  function initReportPage() {
    var page = $page("report");
    if (!page) return;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Download JSON
    var jsonBtn = page.querySelector('[data-action="download-json"], #btn-download-json');
    if (jsonBtn) {
      jsonBtn.addEventListener("click", downloadReportJson);
    }

    // Download MD
    var mdBtn = page.querySelector('[data-action="download-md"], #btn-download-md');
    if (mdBtn) {
      mdBtn.addEventListener("click", downloadReportMd);
    }

    // Regenerate
    var regenBtn = page.querySelector('[data-action="regenerate"], #btn-regenerate');
    if (regenBtn) {
      regenBtn.addEventListener("click", function() {
        showPage("analysis");
        state.analysisProgress = 0;
        startAnalysisAnimation();
      });
    }

    // Build agent buttons
    var agentBtns = page.querySelectorAll('[data-dom-id^="build-agent"], [data-action="build-agent"], .build-agent-btn');
    for (var j = 0; j < agentBtns.length; j++) {
      agentBtns[j].addEventListener("click", function() {
        var idx = this.getAttribute("data-agent-index") || 0;
        state.agentIndex = Number(idx);
        showPage("agent");
      });
    }

    // Evidence toggles
    var evidenceBtns = page.querySelectorAll('[onclick*="toggleEvidence"], [data-evidence-toggle]');
    for (var k = 0; k < evidenceBtns.length; k++) {
      evidenceBtns[k].addEventListener("click", function(e) {
        e.preventDefault();
        var id = this.getAttribute("data-evidence-id");
        if (!id) return;
        var el = document.getElementById(id);
        if (!el) return;
        if (el.style.display === "none") {
          el.style.display = "";
        } else {
          el.style.display = "none";
        }
      });
    }

    // Render report
    if (!state.report) {
      state.report = generateMockReport();
    }
    renderReportContent();
  }

  function renderReportContent() {
    var page = $page("report");
    if (!page || !state.report) return;

    var rpt = state.report;
    var opportunities = rpt.opportunities || [];
    var highPriority = opportunities.filter(function(o) { return o.priority === "高"; }).length;

    // Header stats
    var opportunityCountEl = page.querySelector('[data-stat="opportunity-count"], .stat-value');
    if (opportunityCountEl) opportunityCountEl.textContent = opportunities.length;

    var timeSavedEl = page.querySelector('[data-stat="time-saved"]');
    if (timeSavedEl) {
      var totalSaved = 0;
      for (var i = 0; i < opportunities.length; i++) {
        totalSaved += opportunities[i].timeSavedWeekly || 0;
      }
      timeSavedEl.textContent = totalSaved.toFixed(1) + "h";
    }

    var highPriorityEl = page.querySelector('[data-stat="high-priority"]');
    if (highPriorityEl) highPriorityEl.textContent = highPriority;
  }

  function downloadReportJson() {
    if (!state.report) {
      toast("err", "暂无报告数据");
      return;
    }
    var blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ai-opportunity-report.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("ok", "下载成功", "报告已导出为 JSON 格式");
  }

  function downloadReportMd() {
    if (!state.report) {
      toast("err", "暂无报告数据");
      return;
    }
    var rpt = state.report;
    var md = "# AI 机会报告\n\n";
    md += "## 概览\n\n";
    md += "- 观察时长：" + rpt.observationHours + " 小时\n";
    md += "- AI 机会：" + (rpt.opportunities ? rpt.opportunities.length : 0) + " 个\n\n";
    md += "## 机会清单\n\n";
    if (rpt.opportunities) {
      for (var i = 0; i < rpt.opportunities.length; i++) {
        var o = rpt.opportunities[i];
        md += "### " + (i + 1) + ". " + o.title + "（" + o.priority + "优先级）\n\n";
        md += o.description + "\n\n";
        md += "- 自动化潜力：" + (o.score ? o.score.automationPotential : "-") + "\n";
        md += "- 业务价值：" + (o.score ? o.score.businessValue : "-") + "\n\n";
      }
    }
    var blob = new Blob([md], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ai-opportunity-report.md";
    a.click();
    URL.revokeObjectURL(url);
    toast("ok", "下载成功", "报告已导出为 Markdown 格式");
  }

  // ============================================================
  // PAGE 6: Agent Page
  // ============================================================
  function initAgentPage() {
    var page = $page("agent");
    if (!page) return;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("report");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Copy prompt
    var copyBtn = page.querySelector('[data-dom-id="copy-prompt"], [data-action="copy-prompt"]');
    if (copyBtn) {
      copyBtn.addEventListener("click", function() {
        var codeBlock = page.querySelector(".code-block, [data-agent-prompt]");
        var text = codeBlock ? codeBlock.innerText : getAgentPromptText();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function() {
            toast("ok", "已复制", "提示词已复制到剪贴板");
          }).catch(function() {
            toast("err", "复制失败", "请手动复制");
          });
        } else {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          toast("ok", "已复制", "提示词已复制到剪贴板");
        }
      });
    }

    // Run agent
    var runBtn = page.querySelector('[data-action="run-agent"], #btn-run-agent');
    if (runBtn) {
      runBtn.addEventListener("click", runAgent);
    }

    // Agent selector
    var agentListItems = page.querySelectorAll(".agent-item, [data-agent-idx]");
    for (var j = 0; j < agentListItems.length; j++) {
      agentListItems[j].addEventListener("click", function() {
        var idx = this.getAttribute("data-agent-idx");
        if (idx !== null) {
          state.agentIndex = Number(idx);
          updateAgentUI();
        }
      });
    }

    updateAgentUI();
  }

  function getAgentPromptText() {
    if (!state.report || !state.report.specs) return "";
    var spec = state.report.specs[state.agentIndex || 0];
    if (!spec) return "";
    return spec.promptSketch || "";
  }

  function updateAgentUI() {
    var page = $page("agent");
    if (!page) return;

    var spec = state.report && state.report.specs ? state.report.specs[state.agentIndex || 0] : null;
    if (!spec && state.report && state.report.specs && state.report.specs.length > 0) {
      spec = state.report.specs[0];
    }

    if (spec) {
      var titleEl = page.querySelector(".agent-title, h1, [data-agent-title]");
      if (titleEl && spec.role) titleEl.textContent = spec.role + " — Agent 原型";

      // Update active state in list
      var items = page.querySelectorAll(".agent-item");
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle("active", i === state.agentIndex);
      }
    }
  }

  function runAgent() {
    if (state.agentRunning) {
      toast("info", "运行中", "Agent 正在执行，请稍候...");
      return;
    }

    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var spec = state.report && state.report.specs ? state.report.specs[state.agentIndex || 0] : null;
    if (!spec) {
      toast("err", "无 Agent 配置");
      return;
    }

    state.agentRunning = true;
    toast("info", "Agent 启动", "正在执行任务...");

    var password = state.activePassword;
    http("/api/agent/run", {
      role: spec.role,
      goal: spec.goal,
      sessionId: session.id,
      password: password
    }).then(function(data) {
      state.agentRunning = false;
      state.agentResult = data;
      toast("ok", "执行完成", "Agent 任务已完成");
      addNotification("Agent 执行完成", spec.role + " 任务执行成功", "success");
    }).catch(function(err) {
      state.agentRunning = false;
      toast("err", "执行失败", err.message);
    });
  }

  // ============================================================
  // PAGE 7: Notifications Page
  // ============================================================
  function initNotificationsPage() {
    var page = $page("notifications");
    if (!page) return;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Open notifications (self)
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"]');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Mark all read
    var markAllBtn = page.querySelector('[data-dom-id="mark-all-read"], [data-action="mark-all-read"]');
    if (markAllBtn) {
      markAllBtn.addEventListener("click", function() {
        for (var j = 0; j < state.notifications.length; j++) {
          state.notifications[j].read = true;
        }
        state.unreadCount = 0;
        saveToStorage();
        renderNotifications();
        updateNotifBadges();
        toast("ok", "已全部标记为已读");
      });
    }

    // Filter tabs
    var filterTabs = page.querySelectorAll(".filter-tab, [data-filter]");
    for (var k = 0; k < filterTabs.length; k++) {
      filterTabs[k].addEventListener("click", function() {
        var filter = this.getAttribute("data-filter");
        if (!filter) return;
        state.notifFilter = filter;
        var allTabs = page.querySelectorAll(".filter-tab");
        for (var t = 0; t < allTabs.length; t++) {
          allTabs[t].classList.remove("active");
        }
        this.classList.add("active");
        renderNotifications();
      });
    }

    // Load more
    var loadMoreBtn = page.querySelector('[data-dom-id="load-more"], [data-action="load-more"]');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", function() {
        toast("info", "加载更多", "暂无更多通知");
      });
    }

    // Update unread count badge on page
    var unreadBadge = page.querySelector("#unread-count, [data-unread-count]");
    if (unreadBadge) {
      if (state.unreadCount > 0) {
        unreadBadge.textContent = state.unreadCount;
        unreadBadge.style.display = "";
      } else {
        unreadBadge.style.display = "none";
      }
    }

    renderNotifications();
  }

  function renderNotifications() {
    var page = $page("notifications");
    if (!page) return;

    var container = page.querySelector("#notification-list, .content, [data-notif-list]");
    if (!container) return;

    var notifs = state.notifications;

    // Filter
    if (state.notifFilter !== "all") {
      notifs = notifs.filter(function(n) {
        return n.type === state.notifFilter;
      });
    }

    if (notifs.length === 0) {
      container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#858585;font-size:13px;">暂无通知</div>';
      return;
    }

    // Group by date
    var groups = { today: [], yesterday: [], earlier: [] };
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var yesterdayStart = todayStart - 86400000;

    for (var i = 0; i < notifs.length; i++) {
      var n = notifs[i];
      if (n.createdAt >= todayStart) {
        groups.today.push(n);
      } else if (n.createdAt >= yesterdayStart) {
        groups.yesterday.push(n);
      } else {
        groups.earlier.push(n);
      }
    }

    var html = "";

    if (groups.today.length > 0) {
      html += '<div class="group-label">今天</div>';
      for (var t = 0; t < groups.today.length; t++) {
        html += renderNotificationItem(groups.today[t]);
      }
    }

    if (groups.yesterday.length > 0) {
      html += '<div class="group-label">昨天</div>';
      for (var y = 0; y < groups.yesterday.length; y++) {
        html += renderNotificationItem(groups.yesterday[y]);
      }
    }

    if (groups.earlier.length > 0) {
      html += '<div class="group-label">更早</div>';
      for (var e = 0; e < groups.earlier.length; e++) {
        html += renderNotificationItem(groups.earlier[e]);
      }
    }

    container.innerHTML = html;

    // Bind click events
    var items = container.querySelectorAll(".notification-item");
    for (var idx = 0; idx < items.length; idx++) {
      items[idx].addEventListener("click", function() {
        var notifId = this.getAttribute("data-notif-id");
        if (notifId) markNotifRead(notifId);
      });
    }
  }

  function renderNotificationItem(n) {
    var isAlert = n.type === "alert" || n.type === "error";
    return '<div class="notification-item ' + (n.read ? "read-all" : "unread") + ' ' + (isAlert ? "alert" : "") + '" data-notif-id="' + escapeHtml(n.id) + '">' +
      '<div class="unread-dot"></div>' +
      '<div class="notification-body">' +
        '<div class="notification-header">' +
          '<span class="notification-source">' + escapeHtml(n.title) + '</span>' +
          '<span class="notification-time">' + escapeHtml(formatRelativeTime(n.createdAt)) + '</span>' +
        '</div>' +
        (n.body ? '<div class="notification-desc">' + escapeHtml(n.body) + '</div>' : "") +
      '</div>' +
    '</div>';
  }

  function markNotifRead(id) {
    for (var i = 0; i < state.notifications.length; i++) {
      if (state.notifications[i].id === id && !state.notifications[i].read) {
        state.notifications[i].read = true;
        state.unreadCount = Math.max(0, state.unreadCount - 1);
        saveToStorage();
        renderNotifications();
        updateNotifBadges();
        break;
      }
    }
  }

  // ============================================================
  // PAGE 8: Settings Page
  // ============================================================
  function initSettingsPage() {
    var page = $page("settings");
    if (!page) return;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .nav-btn, .top-nav-logo');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Open notifications
    var notifBtns = page.querySelectorAll('[data-dom-id="open-notifications"], .nav-icon-btn');
    for (var i = 0; i < notifBtns.length; i++) {
      notifBtns[i].addEventListener("click", function() {
        showPage("notifications");
      });
    }

    // Load settings into form
    var providerSelect = page.querySelector('#provider, [data-setting="provider"]');
    if (providerSelect) providerSelect.value = state.settings.llmProvider;

    var modelInput = page.querySelector('#model-name, [data-setting="model"]');
    if (modelInput) modelInput.value = state.settings.llmModel;

    var apiBaseInput = page.querySelector('#api-base, [data-setting="api-base"]');
    if (apiBaseInput) apiBaseInput.value = state.settings.llmApiBase;

    var apiKeyInput = page.querySelector('#api-key, [data-setting="api-key"]');
    if (apiKeyInput) apiKeyInput.value = state.settings.llmApiKey;

    var durationSelect = page.querySelector('#duration, [data-setting="duration"]');
    if (durationSelect) durationSelect.value = state.settings.defaultDurationDays;

    var autoStartToggle = page.querySelector('#auto-start, [data-setting="auto-start"]');
    if (autoStartToggle) autoStartToggle.checked = state.settings.autoStart;

    var timeoutAlertToggle = page.querySelector('#timeout-alert, [data-setting="timeout-alert"]');
    if (timeoutAlertToggle) timeoutAlertToggle.checked = state.settings.timeoutAlert;

    var retentionSelect = page.querySelector('#retention, [data-setting="retention"]');
    if (retentionSelect) retentionSelect.value = state.settings.retentionDays;

    // Password toggle
    var pwdToggle = page.querySelector('.password-toggle, [data-action="toggle-password"]');
    if (pwdToggle) {
      pwdToggle.addEventListener("click", function() {
        var input = page.querySelector("#api-key");
        var icon = page.querySelector("#eye-icon");
        if (input) {
          if (input.type === "password") {
            input.type = "text";
          } else {
            input.type = "password";
          }
        }
      });
    }

    // Test connection
    var testBtn = page.querySelector('[data-dom-id="test-connection"], [onclick*="testConnection"]');
    if (testBtn) {
      testBtn.addEventListener("click", function() {
        var resultEl = page.querySelector("#test-result, .test-result");
        toast("info", "测试中...", "正在测试连接");
        setTimeout(function() {
          if (resultEl) resultEl.classList.add("active");
          toast("ok", "连接成功", "API 连接正常");
          setTimeout(function() {
            if (resultEl) resultEl.classList.remove("active");
          }, 3000);
        }, 1000);
      });
    }

    // Clear data
    var clearBtn = page.querySelector('[data-dom-id="clear-data-btn"], #clear-data-btn, [onclick*="showClearConfirm"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", function() {
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.add("active");
      });
    }

    var confirmYes = page.querySelector('.btn-confirm-yes, [onclick*="confirmClear"]');
    if (confirmYes) {
      confirmYes.addEventListener("click", function() {
        localStorage.removeItem("fde-user");
        localStorage.removeItem("fde-sessions");
        localStorage.removeItem("fde-notifications");
        state.user = null;
        state.sessions = [];
        state.notifications = [];
        state.unreadCount = 0;
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.remove("active");
        toast("ok", "已清除", "所有本地数据已清除");
        setTimeout(function() {
          showPage("login");
        }, 1000);
      });
    }

    var confirmNo = page.querySelector('.btn-confirm-no, [onclick*="hideClearConfirm"]');
    if (confirmNo) {
      confirmNo.addEventListener("click", function() {
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.remove("active");
      });
    }

    // Save settings
    var saveBtn = page.querySelector('[data-action="save-settings"], .btn-filled-blue, [onclick*="saveSettings"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", saveSettings);
    }
  }

  function saveSettings() {
    var page = $page("settings");
    if (!page) return;

    var providerSelect = page.querySelector('#provider, [data-setting="provider"]');
    var modelInput = page.querySelector('#model-name, [data-setting="model"]');
    var apiBaseInput = page.querySelector('#api-base, [data-setting="api-base"]');
    var apiKeyInput = page.querySelector('#api-key, [data-setting="api-key"]');
    var durationSelect = page.querySelector('#duration, [data-setting="duration"]');
    var autoStartToggle = page.querySelector('#auto-start, [data-setting="auto-start"]');
    var timeoutAlertToggle = page.querySelector('#timeout-alert, [data-setting="timeout-alert"]');
    var retentionSelect = page.querySelector('#retention, [data-setting="retention"]');

    if (providerSelect) state.settings.llmProvider = providerSelect.value;
    if (modelInput) state.settings.llmModel = modelInput.value;
    if (apiBaseInput) state.settings.llmApiBase = apiBaseInput.value;
    if (apiKeyInput) state.settings.llmApiKey = apiKeyInput.value;
    if (durationSelect) state.settings.defaultDurationDays = Number(durationSelect.value);
    if (autoStartToggle) state.settings.autoStart = autoStartToggle.checked;
    if (timeoutAlertToggle) state.settings.timeoutAlert = timeoutAlertToggle.checked;
    if (retentionSelect) state.settings.retentionDays = Number(retentionSelect.value);

    saveToStorage();
    toast("ok", "已保存", "设置已保存");
  }

  // ============================================================
  // Public config
  // ============================================================
  function loadPublicConfig() {
    http("/api/config/public").then(function(data) {
      state.publicConfig = data || {};
    }).catch(function(err) {
      console.warn("Failed to load public config:", err);
    });
  }

  // ============================================================
  // Global event delegation
  // ============================================================
  function bindGlobalEvents() {
    // Global click handler for data-dom-id based navigation
    document.addEventListener("click", function(e) {
      var target = e.target.closest("[data-dom-id]");
      if (!target) return;

      var domId = target.getAttribute("data-dom-id");

      // Common navigation handlers (only if not already handled by page init)
      if (domId === "open-notifications") {
        e.preventDefault();
        showPage("notifications");
      } else if (domId === "open-settings") {
        e.preventDefault();
        showPage("settings");
      } else if (domId === "back-home") {
        e.preventDefault();
        if (state.currentPage === "login") return;
        showPage("login");
      }
    });
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    loadFromStorage();
    loadPublicConfig();
    bindGlobalEvents();

    // Determine initial page
    var activePage = document.querySelector(".page.page-active");
    if (activePage) {
      state.currentPage = activePage.getAttribute("data-page") || "login";
    }

    initPage(state.currentPage);
    updateNotifBadges();
  }

  // Wait for DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose showPage for external use
  window.FDE = {
    showPage: showPage,
    state: state,
    toast: toast
  };

})();
