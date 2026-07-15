(function(window) {
  'use strict';

  var FDE = window.FDE || {};
  window.FDE = FDE;

  FDE.state = {
    user: null,
    token: null,
    refreshToken: null,
    sessions: [],
    activeSessionId: null,
    activePassword: '',
    sessionPasswordCache: {},
    notifications: [],
    unreadCount: 0
  };

  FDE.utils = {
    escapeHtml: function(s) {
      return String(s || '').replace(/[&<>"/']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;' }[c];
      });
    },

    formatBytes: function(bytes) {
      if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    },

    formatDuration: function(ms) {
      var s = Math.floor(ms / 1000);
      var m = Math.floor(s / 60);
      var h = Math.floor(m / 60);
      var mm = String(m % 60).padStart(2, '0');
      var ss = String(s % 60).padStart(2, '0');
      if (h > 0) return h + ':' + mm + ':' + ss;
      return mm + ':' + ss;
    },

    formatTime: function(ts) {
      return new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    },

    formatRelativeTime: function(ts) {
      var diff = Date.now() - ts;
      var min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + ' 分钟前';
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' 小时前';
      var day = Math.floor(hr / 24);
      if (day < 7) return day + ' 天前';
      return this.formatTime(ts);
    },

    getRandomInt: function(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    generateId: function() {
      return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }
  };

  FDE.storage = {
    save: function() {
      try {
        localStorage.setItem('fde-user', JSON.stringify(FDE.state.user || {}));
        localStorage.setItem('fde-token', FDE.state.token || '');
        localStorage.setItem('fde-refresh-token', FDE.state.refreshToken || '');
        localStorage.setItem('fde-sessions', JSON.stringify(FDE.state.sessions || []));
        localStorage.setItem('fde-notifications', JSON.stringify(FDE.state.notifications || []));
        localStorage.setItem('fde-password-cache', JSON.stringify(FDE.state.sessionPasswordCache || {}));
      } catch(e) {}
    },

    load: function() {
      try {
        var user = localStorage.getItem('fde-user');
        if (user) FDE.state.user = JSON.parse(user);
        FDE.state.token = localStorage.getItem('fde-token') || null;
        FDE.state.refreshToken = localStorage.getItem('fde-refresh-token') || null;
        var sessions = localStorage.getItem('fde-sessions');
        if (sessions) FDE.state.sessions = JSON.parse(sessions);
        var notifs = localStorage.getItem('fde-notifications');
        if (notifs) FDE.state.notifications = JSON.parse(notifs);
        var cache = localStorage.getItem('fde-password-cache');
        if (cache) FDE.state.sessionPasswordCache = JSON.parse(cache);
        FDE.storage.updateUnreadCount();
      } catch(e) {}
    },

    clear: function() {
      FDE.state.user = null;
      FDE.state.token = null;
      FDE.state.refreshToken = null;
      FDE.state.activeSessionId = null;
      FDE.state.activePassword = '';
      localStorage.removeItem('fde-user');
      localStorage.removeItem('fde-token');
      localStorage.removeItem('fde-refresh-token');
      localStorage.removeItem('fde-sessions');
      localStorage.removeItem('fde-password-cache');
    },

    updateUnreadCount: function() {
      var count = 0;
      for (var i = 0; i < FDE.state.notifications.length; i++) {
        if (!FDE.state.notifications[i].read) count++;
      }
      FDE.state.unreadCount = count;
      FDE.ui.updateNotifBadges();
    },

    addNotification: function(title, body, type) {
      var notif = {
        id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        title: title,
        body: body || '',
        type: type || 'info',
        read: false,
        createdAt: Date.now()
      };
      FDE.state.notifications.unshift(notif);
      FDE.state.unreadCount++;
      FDE.storage.save();
      FDE.ui.updateNotifBadges();
    }
  };

  FDE.http = {
    get: function(path, opts) {
      return this.request('GET', path, null, opts);
    },

    post: function(path, body, opts) {
      return this.request('POST', path, body, opts);
    },

    delete: function(path, opts) {
      return this.request('DELETE', path, null, opts);
    },

    request: function(method, path, body, opts) {
      opts = opts || {};
      var headers = { 'content-type': 'application/json' };
      
      if (FDE.state.token) {
        headers['Authorization'] = 'Bearer ' + FDE.state.token;
      }

      if (opts.headers) {
        for (var k in opts.headers) {
          if (opts.headers.hasOwnProperty(k)) {
            headers[k] = opts.headers[k];
          }
        }
      }

      var isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
      if (isFormData) {
        delete headers['content-type'];
      }

      var fetchOpts = {
        method: method,
        headers: headers,
        body: body ? (isFormData ? body : JSON.stringify(body)) : undefined
      };

      return fetch(path, fetchOpts).then(function(res) {
        if (!res.ok && res.status !== 201) {
          return res.json().catch(function() { return {}; }).then(function(msg) {
            throw new Error(msg.error || ('HTTP ' + res.status));
          });
        }
        return res.json();
      });
    }
  };

  FDE.auth = {
    login: function(email, password) {
      return FDE.http.post('/api/auth/login', { email: email, password: password }).then(function(data) {
        FDE.state.user = { email: email, name: email.split('@')[0], loginAt: Date.now() };
        FDE.state.token = data.accessToken;
        FDE.state.refreshToken = data.refreshToken;
        FDE.storage.save();
        FDE.storage.addNotification('登录成功', '欢迎使用 AI FDE 助手', 'success');
        return data;
      });
    },

    register: function(email, username, password) {
      return FDE.http.post('/api/auth/register', { email: email, username: username, password: password }).then(function(data) {
        FDE.state.user = { email: email, name: username, loginAt: Date.now() };
        FDE.state.token = data.accessToken;
        FDE.state.refreshToken = data.refreshToken;
        FDE.storage.save();
        FDE.storage.addNotification('注册成功', '欢迎使用 AI FDE 助手', 'success');
        return data;
      });
    },

    logout: function() {
      FDE.storage.clear();
      FDE.storage.addNotification('已退出登录', '您已安全退出', 'info');
    },

    isAuthenticated: function() {
      return !!FDE.state.token && !!FDE.state.user;
    },

    refreshToken: function() {
      if (!FDE.state.refreshToken) return Promise.reject(new Error('No refresh token'));
      return FDE.http.post('/api/auth/refresh', { refreshToken: FDE.state.refreshToken }).then(function(data) {
        FDE.state.token = data.accessToken;
        FDE.state.refreshToken = data.refreshToken;
        FDE.storage.save();
        return data;
      });
    }
  };

  FDE.session = {
    list: function() {
      return FDE.http.get('/api/sessions').then(function(data) {
        if (data && data.sessions) {
          FDE.state.sessions = data.sessions;
          FDE.storage.save();
        }
        return FDE.state.sessions;
      });
    },

    create: function(options) {
      return FDE.http.post('/api/sessions', options).then(function(data) {
        if (data && data.session) {
          var session = data.session;
          session.name = options.roleName ? (options.roleName + '助手') : ('会话 ' + session.id.slice(-8));
          session.status = 'idle';
          session.eventCount = 0;
          session.progress = 0;
          FDE.state.sessions.unshift(session);
          FDE.storage.save();
        }
        return data;
      });
    },

    start: function(sessionId, password) {
      return FDE.http.post('/api/sessions/' + sessionId + '/start', { password: password }).then(function(data) {
        var session = FDE.session.get(sessionId);
        if (session) {
          session.status = 'recording';
          FDE.storage.save();
        }
        FDE.storage.addNotification('观察已开始', '会话正在录制中', 'success');
        return data;
      });
    },

    pause: function(sessionId, password) {
      return FDE.http.post('/api/sessions/' + sessionId + '/pause', { password: password }).then(function(data) {
        var session = FDE.session.get(sessionId);
        if (session) {
          session.status = 'paused';
          FDE.storage.save();
        }
        FDE.storage.addNotification('观察已暂停', '会话已暂停', 'info');
        return data;
      });
    },

    finalize: function(sessionId, password) {
      return FDE.http.post('/api/sessions/' + sessionId + '/finalize', { password: password }).then(function(data) {
        var session = FDE.session.get(sessionId);
        if (session) {
          session.status = 'finalized';
          FDE.storage.save();
        }
        FDE.storage.addNotification('观察已结束', '正在生成分析报告', 'success');
        return data;
      });
    },

    get: function(sessionId) {
      for (var i = 0; i < FDE.state.sessions.length; i++) {
        if (FDE.state.sessions[i].id === sessionId) {
          return FDE.state.sessions[i];
        }
      }
      return null;
    },

    getEvents: function(sessionId, password, offset, limit) {
      var url = '/api/sessions/' + sessionId + '/events?offset=' + (offset || 0) + '&limit=' + (limit || 50) + '&password=' + encodeURIComponent(password);
      return FDE.http.get(url);
    },

    delete: function(sessionId) {
      return FDE.http.delete('/api/sessions/' + sessionId).then(function(data) {
        FDE.state.sessions = FDE.state.sessions.filter(function(s) {
          return s.id !== sessionId;
        });
        FDE.storage.save();
        return data;
      });
    }
  };

  FDE.ws = {
    connection: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 1000,
    listeners: {},

    connect: function(sessionId) {
      return new Promise(function(resolve, reject) {
        var wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var url = wsProtocol + '//' + window.location.host + '/api/ws?sessionId=' + sessionId;
        
        FDE.ws.connection = new WebSocket(url);

        FDE.ws.connection.onopen = function() {
          FDE.ws.reconnectAttempts = 0;
          FDE.ui.toast('ok', 'WebSocket 已连接', '实时事件同步已启用');
          resolve();
        };

        FDE.ws.connection.onmessage = function(event) {
          var data;
          try {
            data = JSON.parse(event.data);
          } catch(e) {
            return;
          }
          FDE.ws.dispatch(data);
        };

        FDE.ws.connection.onerror = function(error) {
          FDE.ui.toast('warn', 'WebSocket 连接异常', '正在尝试重连...');
        };

        FDE.ws.connection.onclose = function(event) {
          if (!event.wasClean && FDE.ws.reconnectAttempts < FDE.ws.maxReconnectAttempts) {
            setTimeout(function() {
              FDE.ws.reconnectAttempts++;
              FDE.ws.connect(sessionId);
            }, FDE.ws.reconnectDelay * Math.pow(2, FDE.ws.reconnectAttempts - 1));
          }
        };
      });
    },

    disconnect: function() {
      if (FDE.ws.connection) {
        FDE.ws.connection.close();
        FDE.ws.connection = null;
      }
    },

    on: function(eventType, callback) {
      if (!FDE.ws.listeners[eventType]) {
        FDE.ws.listeners[eventType] = [];
      }
      FDE.ws.listeners[eventType].push(callback);
    },

    off: function(eventType, callback) {
      if (!FDE.ws.listeners[eventType]) return;
      FDE.ws.listeners[eventType] = FDE.ws.listeners[eventType].filter(function(cb) {
        return cb !== callback;
      });
    },

    dispatch: function(data) {
      var eventType = data.type || 'message';
      if (FDE.ws.listeners[eventType]) {
        FDE.ws.listeners[eventType].forEach(function(callback) {
          try {
            callback(data);
          } catch(e) {
            console.error('WebSocket listener error:', e);
          }
        });
      }
    }
  };

  FDE.ui = {
    toast: function(kind, title, body) {
      var container = document.getElementById('toast-container');
      if (!container) {
        var el = document.createElement('div');
        el.id = 'toast-container';
        el.className = 'fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none';
        document.body.appendChild(el);
      }
      var host = document.getElementById('toast-container');
      var el = document.createElement('div');
      
      var colors = {
        ok: 'bg-green-500',
        err: 'bg-red-500',
        info: 'bg-blue-500',
        warn: 'bg-yellow-500'
      };
      
      el.className = colors[kind] || colors.info + ' text-white px-4 py-3 rounded-xl shadow-lg text-sm font-medium transform transition-all duration-300 opacity-0 translate-y-2';
      el.innerHTML = '<div class="font-semibold">' + FDE.utils.escapeHtml(title) + '</div>' +
        (body ? '<div class="opacity-90 text-xs mt-1">' + FDE.utils.escapeHtml(body) + '</div>' : '');
      
      host.appendChild(el);
      
      requestAnimationFrame(function() {
        el.classList.remove('opacity-0', 'translate-y-2');
      });
      
      setTimeout(function() {
        el.classList.add('opacity-0', 'translate-x-4');
        setTimeout(function() { el.remove(); }, 300);
      }, 3200);
    },

    updateNotifBadges: function() {
      var badges = document.querySelectorAll('.notif-badge');
      badges.forEach(function(badge) {
        if (FDE.state.unreadCount > 0) {
          badge.textContent = FDE.state.unreadCount;
          badge.style.display = 'flex';
        } else {
          badge.style.display = 'none';
        }
      });
    },

    showPage: function(pageId) {
      document.querySelectorAll('.page').forEach(function(page) {
        page.classList.add('hidden');
      });
      var target = document.getElementById(pageId);
      if (target) {
        target.classList.remove('hidden');
        target.classList.add('flex');
      }
      window.scrollTo(0, 0);
    }
  };

  FDE.init = function() {
    FDE.storage.load();
    
    if (FDE.auth.isAuthenticated()) {
      FDE.session.list().catch(function() {});
    }
  };

  document.addEventListener('DOMContentLoaded', FDE.init);

})(window);