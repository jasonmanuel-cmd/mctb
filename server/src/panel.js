/**
 * The operator control panel.
 *
 * A single self-contained HTML page, served from memory. No build step, no
 * framework, no CDN - which matters because this has to keep working on a
 * tradesperson's phone in a basement with one bar of signal.
 *
 * It talks to the same bearer-authenticated settings API as curl, so there is
 * exactly one code path for writes and no separate admin surface to secure.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Missed Call Reply - control panel</title>
<style>
  :root { color-scheme: light dark; --line: #444; --accent: #2f6feb; --bad: #c62828; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 640px; margin-inline: auto; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .sub { opacity: .7; margin: 0 0 20px; font-size: .9rem; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: .9rem; }
  input, select { width: 100%; padding: 10px; font: inherit; border: 1px solid var(--line);
                  border-radius: 6px; background: transparent; color: inherit; }
  button { font: inherit; padding: 11px 16px; border: 0; border-radius: 6px;
           background: var(--accent); color: #fff; cursor: pointer; margin-top: 18px; }
  button.secondary { background: transparent; color: inherit; border: 1px solid var(--line); }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .check input { width: auto; }
  .msg { margin-top: 16px; padding: 10px; border-radius: 6px; font-size: .9rem; display: none; }
  .msg.ok { display: block; background: #14532d33; }
  .msg.err { display: block; background: #c6282833; }
  .count { font-size: .8rem; opacity: .7; text-align: right; margin-top: 4px; }
  ul { list-style: none; padding: 0; }
  li { border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin-bottom: 8px;
       cursor: pointer; }
  li b { font-weight: 600; }
  .tok {
    font: inherit; font-size: 0.75rem; padding: 0.1rem 0.4rem;
    border: 1px solid var(--line); border-radius: 4px;
    background: transparent; color: var(--fg); cursor: pointer;
  }
  .pill { font-size: .75rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .hidden { display: none; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
</style>
</head>
<body>

<h1>Missed Call Reply</h1>
<p class="sub">Calls that ring out get your text automatically.</p>

<section id="auth">
  <label for="key">API key</label>
  <input id="key" type="password" autocomplete="current-password" placeholder="API_KEY">
  <button id="unlock">Open</button>
  <div id="authMsg" class="msg err">Wrong key.</div>
</section>

<section id="panel" class="hidden">
  <label>Configured numbers</label>
  <ul id="list"></ul>
  <button class="secondary" id="add">+ Add a number</button>

  <hr>

  <form id="form">
    <label for="twilioNumber">Twilio number (what callers dial)</label>
    <input id="twilioNumber" placeholder="+15559000001" required>

    <label for="forwardTo">Forward to (the phone that rings)</label>
    <input id="forwardTo" placeholder="+15558000002" required>

    <label for="message">Auto-reply text</label>
    <textarea id="message" rows="3" style="width:100%;padding:10px;font:inherit;
      border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;"></textarea>
    <div class="count"><span id="len">0</span> / 160</div>

    <div class="row">
      <div>
        <label for="timeZone">Time zone</label>
        <input id="timeZone" placeholder="America/Los_Angeles">
      </div>
      <div>
        <label for="limit">Free replies</label>
        <input id="limit" type="number" min="0">
      </div>
    </div>

    <div class="check">
      <input id="alwaysOn" type="checkbox">
      <label for="alwaysOn" style="margin:0">Reply at any hour</label>
    </div>

    <div class="row" id="hours">
      <div>
        <label for="start">From</label>
        <input id="start" type="time" value="08:00">
      </div>
      <div>
        <label for="end">Until</label>
        <input id="end" type="time" value="18:00">
      </div>
    </div>

    <div class="check">
      <input id="enabled" type="checkbox">
      <label for="enabled" style="margin:0">Active</label>
    </div>

    <button type="submit">Save</button>
    <div id="saveMsg" class="msg"></div>
  </form>
</section>

<script>
(function () {
  var keyEl = document.getElementById('key');
  var key = sessionStorage.getItem('mctbKey') || '';

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + key }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { throw new Error(j.detail || j.error || ('HTTP ' + r.status)); }
        return j;
      });
    });
  }

  function minuteToTime(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function timeToMinute(v) {
    var p = String(v || '0:0').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function load(s) {
    document.getElementById('twilioNumber').value = s.twilioNumber || '';
    document.getElementById('forwardTo').value = s.forwardTo || '';
    document.getElementById('message').value = s.message || '';
    document.getElementById('timeZone').value = s.timeZone || 'UTC';
    document.getElementById('limit').value = s.limit != null ? s.limit : 5;
    document.getElementById('alwaysOn').checked = !!(s.activeHours && s.activeHours.alwaysOn);
    document.getElementById('enabled').checked = !!s.enabled;
    document.getElementById('start').value = minuteToTime(s.activeHours ? s.activeHours.startMinuteOfDay : 480);
    document.getElementById('end').value = minuteToTime(s.activeHours ? s.activeHours.endMinuteOfDay : 1080);
    count();
  }

  function count() {
    var n = document.getElementById('message').value.length;
    var el = document.getElementById('len');
    el.textContent = n;
    el.style.color = n > 160 ? 'var(--bad)' : '';
  }

  function refresh() {
    api('/subscribers').then(function (j) {
      var ul = document.getElementById('list');
      ul.textContent = '';
      (j.subscribers || []).forEach(function (s) {
        var li = document.createElement('li');
        var pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = s.enabled ? 'active' : 'paused';
        li.appendChild(document.createTextNode(s.twilioNumber + '  '));
        li.appendChild(pill);
        li.appendChild(document.createTextNode('   ' + (s.forwardTo || 'no forwarding number')));
        li.onclick = function () { load(s); };

        // Fetched on click rather than rendered with the list: this is a
        // bearer credential, and it has no business sitting in the page source
        // or the browser cache for every subscriber at once.
        var tok = document.createElement('button');
        tok.type = 'button';
        tok.className = 'tok';
        tok.textContent = 'token';
        tok.onclick = function (ev) {
          ev.stopPropagation();
          revealToken(s.twilioNumber, tok);
        };
        li.appendChild(document.createTextNode('   '));
        li.appendChild(tok);

        ul.appendChild(li);
      });
      if (!(j.subscribers || []).length) {
        var empty = document.createElement('li');
        empty.textContent = 'None yet.';
        empty.onclick = null;
        ul.appendChild(empty);
      }
    }).catch(function (e) { show('saveMsg', 'err', e.message); });
  }

  function revealToken(number, btn) {
    api('/subscribers/' + encodeURIComponent(number) + '/token')
      .then(function (j) {
        btn.textContent = j.apiToken || '(none issued)';
        btn.title = 'Give this to the subscriber for the app, along with the server address.';
      })
      .catch(function (e) { show('saveMsg', 'err', e.message); });
  }

  function show(id, kind, text) {
    var el = document.getElementById(id);
    el.className = 'msg ' + kind;
    el.textContent = text;
  }

  document.getElementById('message').addEventListener('input', count);

  document.getElementById('unlock').onclick = function () {
    key = keyEl.value.trim();
    api('/subscribers').then(function () {
      sessionStorage.setItem('mctbKey', key);
      document.getElementById('auth').classList.add('hidden');
      document.getElementById('panel').classList.remove('hidden');
      refresh();
    }).catch(function () {
      key = '';
      document.getElementById('authMsg').style.display = 'block';
    });
  };

  document.getElementById('add').onclick = function () {
    load({ twilioNumber: '', forwardTo: '', message: '', timeZone: 'UTC',
           limit: 5, enabled: false, activeHours: { startMinuteOfDay: 480, endMinuteOfDay: 1080, alwaysOn: false } });
  };

  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    var num = encodeURIComponent(document.getElementById('twilioNumber').value.trim());
    var body = {
      enabled: document.getElementById('enabled').checked,
      forwardTo: document.getElementById('forwardTo').value.trim(),
      message: document.getElementById('message').value,
      timeZone: document.getElementById('timeZone').value.trim() || 'UTC',
      activeHours: {
        alwaysOn: document.getElementById('alwaysOn').checked,
        startMinuteOfDay: timeToMinute(document.getElementById('start').value),
        endMinuteOfDay: timeToMinute(document.getElementById('end').value)
      }
    };
    api('/subscribers/' + num, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      show('saveMsg', 'ok', 'Saved.');
      refresh();
    }).catch(function (err) { show('saveMsg', 'err', err.message); });
  };

  if (key) {
    api('/subscribers').then(function () {
      document.getElementById('auth').classList.add('hidden');
      document.getElementById('panel').classList.remove('hidden');
      refresh();
    }).catch(function () { key = ''; });
  }
})();
</script>
</body>
</html>`;
