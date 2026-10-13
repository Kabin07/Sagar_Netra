/* SAGAR-NETRA shared browser client.
 *
 * Used by the citizen, professional and authority pages. No build step, no
 * framework — same style as the pages themselves.
 *
 *   SN.api(path, {method, body})   JSON request; throws Error(.status, .details)
 *   SN.upload(path, formData, onProgress)  multipart upload with progress
 *   SN.me() / SN.login() / SN.register() / SN.logout()
 *   SN.requireLogin(opts)          page guard: unlocks the page or redirects to /login/
 *   SN.label(cls) / SN.esc(str) / SN.fmtPct(x)
 *
 * Auth is an httpOnly, SameSite=Strict session cookie set by the API, so no token
 * is ever stored in localStorage. Set window.SN_API_BASE before loading this file
 * only if the API runs on a different origin than the page.
 */
(function () {
  "use strict";
  var BASE = (window.SN_API_BASE || "").replace(/\/+$/, "");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function makeError(status, body) {
    var msg = (body && body.error) || (status ? "Request failed (HTTP " + status + ")" : "Cannot reach the SAGAR-NETRA server");
    if (body && body.details) {
      msg += ": " + Object.keys(body.details).map(function (k) { return k + " " + body.details[k]; }).join("; ");
    }
    var e = new Error(msg);
    e.status = status;
    e.details = body && body.details;
    return e;
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "include", headers: {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(BASE + path, init).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw makeError(res.status, body);
        return body;
      });
    }, function () { throw makeError(0, null); });
  }

  /* XHR instead of fetch so the UI can show real upload progress. */
  function upload(path, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", BASE + path);
      xhr.withCredentials = true;
      xhr.timeout = 15 * 60 * 1000;
      xhr.upload.onprogress = function (e) {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.upload.onload = function () { if (onProgress) onProgress(1); };
      xhr.onload = function () {
        var body = {};
        try { body = JSON.parse(xhr.responseText || "{}"); } catch (e) { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(makeError(xhr.status, body));
      };
      xhr.onerror = function () { reject(makeError(0, null)); };
      xhr.ontimeout = function () { reject(new Error("Upload timed out")); };
      xhr.send(formData);
    });
  }

  var current = null;
  function me() {
    return api("/api/users/me").then(function (r) { current = r.user; return r.user; }, function (e) {
      if (e.status === 401) { current = null; return null; }
      throw e;
    });
  }
  function login(email, password) {
    return api("/api/auth/login", { method: "POST", body: { email: email, password: password } })
      .then(function (r) { current = r.user; return r.user; });
  }
  function register(name, email, password, role) {
    return api("/api/auth/register", { method: "POST", body: { name: name, email: email, password: password, role: role } })
      .then(function (r) { current = r.user; return r.user; });
  }
  function logout() {
    return api("/api/auth/logout", { method: "POST" }).catch(function () {}).then(function () { current = null; });
  }

  /* ---------------- sign-in gate ----------------
     Every page hides its content (CSS: body:not(.sn-authed) .sn-protected) until a
     server session is confirmed. Signing in happens on the dedicated /login/ page. */
  var SERVER_HINT = "http://127.0.0.1:4000";

  function loginUrl(next) {
    var root = location.pathname.replace(/\/(professional|citizen|authority|login)\/.*$/, "/");
    return BASE + root + "login/" + (next ? "?next=" + encodeURIComponent(next) : "");
  }

  /* Only same-site absolute paths are allowed as redirect targets (no open redirect). */
  function safeNext(n) {
    return typeof n === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) && n.indexOf("..") === -1 ? n : null;
  }

  function gate(html) {
    var g = document.getElementById("snGate");
    if (g) g.innerHTML = html;
  }

  function unlock(user) {
    document.body.classList.add("sn-authed");
    gate("");
  }

  function lock() {
    current = null;
    document.body.classList.remove("sn-authed");
  }

  /**
   * Confirm a session, then call opts.onReady(user). Without one the browser is sent
   * to /login/?next=<this page>. Opened as a file, or with the server down, the page
   * stays locked and explains what to do.
   */
  function requireLogin(opts) {
    opts = opts || {};
    lock();
    if (location.protocol === "file:") {
      gate("<b>Open this page through the SAGAR-NETRA server.</b> It was opened directly from disk, " +
        "so it cannot sign you in or send reports. Start the services (see README) and go to " +
        '<a href="' + SERVER_HINT + '/login/">' + SERVER_HINT + "/login/</a>.");
      return Promise.resolve(null);
    }
    gate("Checking your session…");
    return me().then(function (user) {
      if (!user) {
        location.replace(loginUrl(location.pathname + location.search));
        return null;
      }
      if (opts.roles && opts.roles.indexOf(user.role) === -1) {
        gate("<b>Your account (" + esc(user.role) + ") cannot use this page.</b> " + (opts.deniedHtml || esc(opts.deniedText || "")) +
          ' <a href="' + loginUrl() + '">Switch account</a>');
        opts.onDenied && opts.onDenied(user);
        return null;
      }
      unlock(user);
      opts.onReady && opts.onReady(user);
      return user;
    }, function (err) {
      gate("<b>Cannot reach the SAGAR-NETRA server.</b> " + esc(err.status ? err.message : "Is the backend running?") +
        ' <a href="">Retry</a>');
      return null;
    });
  }

  function injectStyles() {
    if (document.getElementById("sn-auth-css")) return;
    var st = document.createElement("style");
    st.id = "sn-auth-css";
    st.textContent =
      ".sn-who{display:flex;align-items:center;gap:8px}.sn-out{background:transparent;border:1px solid var(--line,#17415c);color:var(--mut,#8fb3c7);border-radius:8px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer}" +
      ".sn-out:hover{border-color:var(--cyan,#22d3ee);color:var(--ink,#eaf6fb)}";
    document.head.appendChild(st);
  }

  /* Small "name · Sign out" widget for page headers. Signing out returns to /login/. */
  function userBadge(user, onLogout) {
    injectStyles();
    var wrap = document.createElement("span");
    wrap.className = "sn-who";
    wrap.innerHTML = '<span title="' + esc(user.email) + '">' + esc(user.name) + "</span>" +
      '<button type="button" class="sn-out">Sign out</button>';
    wrap.querySelector("button").onclick = function () {
      logout().then(function () { onLogout ? onLogout() : location.replace(loginUrl()); });
    };
    return wrap;
  }

  /* Default landing page per role after login. */
  function homeFor(user) {
    var root = location.pathname.replace(/\/(professional|citizen|authority|login)\/.*$/, "/");
    var page = user.role === "admin" ? "authority/" : user.role === "citizen" ? "citizen/" : "professional/";
    return root + page;
  }

  var LABELS = {
    rov: "ROV", plant: "Plant", animal_fish: "Fish", animal_starfish: "Starfish", animal_shells: "Shells",
    animal_crab: "Crab", animal_eel: "Eel", animal_etc: "Other animal", trash_clothing: "Clothing",
    trash_pipe: "Pipe", trash_bottle: "Bottle", trash_bag: "Plastic bag", trash_snack_wrapper: "Snack wrapper",
    trash_can: "Can", trash_cup: "Cup", trash_container: "Container", trash_unknown_instance: "Unidentified debris",
    trash_branch: "Branch", trash_wreckage: "Wreckage", trash_tarp: "Tarpaulin", trash_rope: "Rope", trash_net: "Ghost net"
  };
  function label(cls) { return LABELS[cls] || String(cls || "").replace(/^trash_|^animal_/, "").replace(/_/g, " "); }
  function fmtPct(x) { return x == null ? "—" : (x * 100).toFixed(0) + "%"; }
  function initials(name) {
    return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }

  window.SN = {
    base: BASE, api: api, upload: upload, me: me, login: login, register: register, logout: logout,
    requireLogin: requireLogin, userBadge: userBadge, loginUrl: loginUrl, safeNext: safeNext, homeFor: homeFor, label: label, esc: esc, fmtPct: fmtPct, initials: initials,
    user: function () { return current; }
  };
})();
