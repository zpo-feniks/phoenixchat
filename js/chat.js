'use strict';
/* ФениксЧат — логика: идентичность, хранилище (localStorage + IndexedDB), интерфейс, запись медиа */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let pendingRtc = null;
let camTimer = null;

/* ---------- Идентичность ---------- */
const App = {
  id: localStorage.getItem('fx.id'),
  /* Имя окна (если меняли в этом окне) важнее общего имени устройства */
  name: sessionStorage.getItem('fx.tabName') || localStorage.getItem('fx.name') || '',
  tab: { id: sessionStorage.getItem('fx.tab') },
  peers: {},          // id -> {name, link, status, unread, msgs, _lastPong}
  activePeer: null,
  urls: new Map(),    // msgId -> objectURL
};
if (!App.id) { App.id = 'D-' + rid(6); localStorage.setItem('fx.id', App.id); }
if (!App.tab.id) { App.tab.id = 'L-' + rid(6); sessionStorage.setItem('fx.tab', App.tab.id); }
if (!App.name) { App.name = 'Гость-' + App.id.slice(2, 5); localStorage.setItem('fx.name', App.name); }
App.tab.name = App.name;

/* ---------- Хранилище ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('fxchat', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('blobs');
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  put(k, b) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('blobs', 'readwrite');
      t.objectStore('blobs').put(b, k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  get(k) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('blobs').objectStore('blobs').get(k);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  del(k) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('blobs', 'readwrite');
      t.objectStore('blobs').delete(k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
};

const Store = {
  /* Данные оконных («L-») собеседников храним в sessionStorage — он отдельный у каждого окна,
     поэтому два окна одного браузера не перезаписывают список бесед друг друга.
     Данные «настоящих» («D-») собеседников — в localStorage, как и раньше. */
  loadPeers() {
    try {
      const ls = JSON.parse(localStorage.getItem('fx.peers') || '{}');
      let dirty = false;
      for (const id in ls) if (id.startsWith('L-')) { delete ls[id]; localStorage.removeItem('fx.msgs.' + id); dirty = true; }
      if (dirty) localStorage.setItem('fx.peers', JSON.stringify(ls));
    } catch (e) {}
    const merge = {};
    try { Object.assign(merge, JSON.parse(localStorage.getItem('fx.peers') || '{}')); } catch (e) {}
    try { Object.assign(merge, JSON.parse(sessionStorage.getItem('fx.peers.local') || '{}')); } catch (e) {}
    return merge;
  },
  savePeers() {
    const dev = {}, loc = {};
    for (const id in App.peers) (id.startsWith('L-') ? loc : dev)[id] = { name: App.peers[id].name };
    localStorage.setItem('fx.peers', JSON.stringify(dev));
    sessionStorage.setItem('fx.peers.local', JSON.stringify(loc));
  },
  msgsKey: id => 'fx.msgs.' + id,
  _st: pid => pid.startsWith('L-') ? sessionStorage : localStorage,
  loadMsgs(pid) { try { return JSON.parse(this._st(pid).getItem(this.msgsKey(pid)) || '[]'); } catch (e) { return []; } },
  saveMsgs(pid, arr) {
    try { this._st(pid).setItem(this.msgsKey(pid), JSON.stringify(arr)); }
    catch (e) { toast('Локальное хранилище переполнено'); }
  },
  delMsgs(pid) { try { this._st(pid).removeItem(this.msgsKey(pid)); } catch (e) {} }
};

/* ---------- Запуск ---------- */
async function init() {
  await DB.open();
  const stored = Store.loadPeers();
  for (const id in stored) {
    const msgs = Store.loadMsgs(id);
    App.peers[id] = {
      name: stored[id].name, link: null, status: 'offline', msgs,
      unread: msgs.filter(m => m.dir === 'in' && !m.read).length, _lastPong: 0
    };
  }
  $('#myName').value = App.name;
  $('#myAvatar').textContent = (App.name[0] || '?').toUpperCase();
  $('#myId').textContent = 'ID: ' + App.id;
  renderChatList();
  flashTitle();
  LocalBus.onpeers = renderLocalPeers;
  LocalBus.onlink = (link, pid, name) => attachLink(pid, name, link);
  LocalBus.start(App.tab);
  wireUI();
  handleHashInvite();
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
  }
  setInterval(pingLinks, 10000);
  updateNetState();
  autoSize();
}

/* ---------- Соединения ---------- */
function attachLink(pid, name, link) {
  let p = App.peers[pid];
  const same = p && p.link === link;
  if (!p) p = App.peers[pid] = { name: name || 'Собеседник', link: null, status: 'connecting', unread: 0, msgs: Store.loadMsgs(pid), _lastPong: 0 };
  if (name) p.name = name;
  if (same) { Store.savePeers(); renderChatList(); if (App.activePeer === pid) updatePeerUI(pid); return; }
  if (p.link && p.link !== link) { try { p.link.close(); } catch (e) {} }
  p.link = link;
  p._lastPong = Date.now();
  p.status = link.open ? 'online' : 'connecting';
  link.onframe = f => onFrame(pid, f);
  link.onstate = st => {
    p.status = st === 'open' ? 'online' : 'offline';
    if (st === 'open') {
      p._lastPong = Date.now();
      sendFrame(pid, { t: 'name', name: App.name });
      closeModal('modalPair');
      toast('Соединение установлено: ' + p.name);
    } else {
      toast('Соединение закрыто: ' + p.name);
    }
    updateNetState(); renderChatList();
    if (App.activePeer === pid) updatePeerUI(pid);
  };
  Store.savePeers();
  renderChatList(); updateNetState();
  if (!App.activePeer) openChat(pid); else if (App.activePeer === pid) updatePeerUI(pid);
}

function sendFrame(pid, obj) {
  const p = App.peers[pid];
  if (p && p.link && p.link.open) { try { p.link.sendText(obj); } catch (e) {} }
}

function pingLinks() {
  const now = Date.now();
  for (const pid in App.peers) {
    const p = App.peers[pid];
    if (!p.link || !p.link.open) continue;
    if (p._lastPong && now - p._lastPong > 45000) {
      try { p.link.close(); } catch (e) {}
      p.status = 'offline';
      continue;
    }
    sendFrame(pid, { t: 'ping' });
  }
}

function onFrame(pid, f) {
  const p = App.peers[pid]; if (!p) return;
  if (f.t === 'ping') { sendFrame(pid, { t: 'pong' }); return; }
  if (f.t === 'pong') { p._lastPong = Date.now(); return; }
  if (f.t === 'name') {
    p.name = f.name; Store.savePeers(); renderChatList();
    if (App.activePeer === pid) updatePeerUI(pid);
    return;
  }
  if (f.t === 'read') {
    let ch = false;
    for (const id of f.ids) {
      const m = p.msgs.find(x => x.id === id);
      if (m && m.status !== 'read') { m.status = 'read'; ch = true; }
    }
    if (ch) { Store.saveMsgs(pid, p.msgs); if (App.activePeer === pid) renderMessages(pid); }
    return;
  }
  if (f.t === 'msg') {
    p.msgs.push({ id: f.id, dir: 'in', ts: f.ts || Date.now(), kind: 'text', txt: f.txt, read: false });
    if (f.name && f.name !== p.name) p.name = f.name;
    afterIncoming(pid);
  } else if (f.t === 'blob') {
    const meta = { id: f.meta.id, dir: 'in', ts: Date.now(), kind: f.meta.kind, name: f.meta.name, mime: f.meta.mime, size: f.meta.size, read: false };
    DB.put(meta.id, f.blob).catch(() => {});
    p.msgs.push(meta);
    afterIncoming(pid);
  }
}

function afterIncoming(pid) {
  const p = App.peers[pid];
  Store.savePeers(); Store.saveMsgs(pid, p.msgs);
  if (App.activePeer === pid) { renderMessages(pid); markRead(pid); }
  else p.unread = p.msgs.filter(m => m.dir === 'in' && !m.read).length;
  renderChatList(); flashTitle(); beep();
}

/* ---------- Отправка ---------- */
function sendText() {
  const pid = App.activePeer; if (!pid) return;
  const p = App.peers[pid]; if (!p) return;
  const el = $('#input');
  const txt = el.value.trim(); if (!txt) return;
  if (!p.link || !p.link.open) { toast('Нет соединения — сообщение не отправлено'); return; }
  const id = rid(10);
  const meta = { id, dir: 'out', ts: Date.now(), kind: 'text', txt, status: 'sending' };
  p.msgs.push(meta);
  el.value = ''; autoSize();
  sendFrame(pid, { t: 'msg', id, ts: meta.ts, txt, name: App.name });
  meta.status = 'sent';
  Store.saveMsgs(pid, p.msgs);
  renderMessages(pid); renderChatList();
}

async function sendBlobMsg(pid, blob, kind, extra) {
  const p = App.peers[pid];
  if (!p || !p.link || !p.link.open) { toast('Нет соединения'); return; }
  const id = rid(10);
  const meta = Object.assign({ id, dir: 'out', ts: Date.now(), kind, size: blob.size, status: 'sending' }, extra || {});
  p.msgs.push(meta); Store.saveMsgs(pid, p.msgs);
  renderMessages(pid); renderChatList();
  await DB.put(id, blob);
  try {
    await p.link.sendBlob(blob, { id, kind, name: meta.name, mime: meta.mime });
    meta.status = 'sent';
  } catch (e) { meta.status = 'error'; }
  Store.saveMsgs(pid, p.msgs);
  const tick = document.querySelector('[data-msg="' + id + '"] .ticks');
  if (tick) tick.textContent = ticks(meta);
  renderChatList();
}

/* ---------- Интерфейс: список чатов ---------- */
function renderChatList() {
  const box = $('#chatList'); box.innerHTML = '';
  const ids = Object.keys(App.peers).sort((a, b) => lastTs(b) - lastTs(a));
  for (const id of ids) {
    const p = App.peers[id];
    const last = p.msgs[p.msgs.length - 1];
    const it = document.createElement('div');
    it.className = 'chat-item' + (App.activePeer === id ? ' active' : '');
    it.innerHTML =
      '<div class="avatar">' + esc((p.name || '?')[0].toUpperCase()) + '</div>' +
      '<div class="ci-main"><div class="ci-name">' + esc(p.name) + '</div>' +
      '<div class="ci-last">' + esc(preview(last, p)) + '</div></div>' +
      '<div class="ci-side"><div class="ci-time">' + (last ? fmtTime(last.ts) : '') + '</div>' +
      (p.unread ? '<div class="badge">' + p.unread + '</div>' : '') + '</div>';
    it.onclick = () => openChat(id);
    it.oncontextmenu = e => {
      e.preventDefault();
      if (confirm('Удалить беседу с «' + p.name + '» и всю историю?')) deletePeer(id);
    };
    box.appendChild(it);
  }
}

function preview(m, p) {
  if (!m) return p.status === 'online' ? 'в сети' : 'нет сообщений';
  const who = m.dir === 'out' ? 'Вы: ' : '';
  if (m.kind === 'text') return who + m.txt;
  if (m.kind === 'voice') return who + '🎙 Голосовое';
  if (m.kind === 'video') return who + '🎬 Видео';
  if (m.kind === 'image') return who + '🖼 Фото';
  return who + '📎 ' + (m.name || 'файл');
}
function lastTs(pid) { const p = App.peers[pid]; return p && p.msgs.length ? p.msgs[p.msgs.length - 1].ts : 0; }

async function deletePeer(pid) {
  const p = App.peers[pid]; if (!p) return;
  for (const m of p.msgs) if (m.kind !== 'text') DB.del(m.id).catch(() => {});
  Store.delMsgs(pid);
  if (p.link) { try { p.link.close(); } catch (e) {} }
  delete App.peers[pid];
  Store.savePeers();
  if (App.activePeer === pid) {
    App.activePeer = null;
    $('#chat').hidden = true; $('#empty').hidden = false;
    document.body.classList.remove('chat-open');
  }
  renderChatList(); updateNetState();
}

/* ---------- Интерфейс: чат ---------- */
let renderSeq = 0;
function openChat(pid) {
  const p = App.peers[pid]; if (!p) return;
  App.activePeer = pid;
  document.body.classList.add('chat-open');
  $('#empty').hidden = true; $('#chat').hidden = false;
  updatePeerUI(pid);
  renderMessages(pid);
  markRead(pid);
  renderChatList();
}

function markRead(pid) {
  const p = App.peers[pid];
  const ids = p.msgs.filter(m => m.dir === 'in' && !m.read).map(m => m.id);
  if (ids.length) {
    p.msgs.forEach(m => { if (m.dir === 'in') m.read = true; });
    Store.saveMsgs(pid, p.msgs);
    sendFrame(pid, { t: 'read', ids });
  }
  p.unread = 0;
  flashTitle();
}

async function renderMessages(pid) {
  const seq = ++renderSeq;
  const p = App.peers[pid]; if (!p) return;
  const box = $('#messages');
  box.innerHTML = '';
  let lastDay = '';
  for (const m of p.msgs) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) {
      lastDay = day;
      const dv = document.createElement('div'); dv.className = 'day'; dv.textContent = day;
      box.appendChild(dv);
    }
    const el = await bubble(m);
    if (seq !== renderSeq) return;
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

async function bubble(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + (m.dir === 'out' ? 'out' : 'in');
  el.dataset.msg = m.id;
  const content = document.createElement('div'); content.className = 'bubble';
  if (m.kind === 'text') {
    const t = document.createElement('div'); t.className = 'txt'; t.textContent = m.txt;
    content.appendChild(t);
  } else if (m.kind === 'voice') {
    const a = document.createElement('audio'); a.controls = true; a.preload = 'metadata';
    a.src = await objUrl(m); content.appendChild(a);
  } else if (m.kind === 'video') {
    const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.preload = 'metadata';
    v.src = await objUrl(m); content.appendChild(v);
  } else if (m.kind === 'image') {
    const i = document.createElement('img'); i.src = await objUrl(m); i.alt = m.name || 'Фото';
    i.onclick = () => window.open(i.src);
    content.appendChild(i);
  } else {
    const a = document.createElement('a'); a.href = await objUrl(m);
    a.download = m.name || 'file';
    a.textContent = '📎 ' + (m.name || 'файл') + ' (' + fmtSize(m.size || 0) + ')';
    content.appendChild(a);
  }
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.innerHTML = '<span class="time">' + fmtTime(m.ts) + '</span><span class="ticks">' + ticks(m) + '</span>';
  content.appendChild(meta);
  el.appendChild(content);
  return el;
}

async function objUrl(m) {
  if (App.urls.has(m.id)) return App.urls.get(m.id);
  const b = await DB.get(m.id);
  const u = b ? URL.createObjectURL(b) : '';
  App.urls.set(m.id, u);
  return u;
}

function updatePeerUI(pid) {
  if (App.activePeer !== pid) return;
  const p = App.peers[pid];
  $('#peerName').textContent = p.name;
  $('#peerAvatar').textContent = (p.name || '?')[0].toUpperCase();
  $('#peerStatus').textContent =
    p.status === 'online' ? 'в сети' :
    p.status === 'connecting' ? 'устанавливаем соединение…' :
    (p.link ? 'соединение потеряно — создайте новое в «Новая беседа»' : 'не в сети');
}
function updateNetState() {
  const n = Object.values(App.peers).filter(p => p.link && p.link.open).length;
  $('#netState').textContent = n ? 'Подключено собеседников: ' + n : 'Не подключено';
}

/* ---------- Форматирование ---------- */
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
function fmtDay(ts) {
  const d = new Date(ts), n = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === n.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU');
}
function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ';
  return (b / 1048576).toFixed(1) + ' МБ';
}
function ticks(m) {
  if (m.dir !== 'out') return '';
  if (m.status === 'read') return '✓✓';
  if (m.status === 'error') return '⚠';
  return '✓';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Обработчики интерфейса ---------- */
function wireUI() {
  $('#myName').addEventListener('change', () => {
    App.name = $('#myName').value.trim() || App.name;
    localStorage.setItem('fx.name', App.name);
    sessionStorage.setItem('fx.tabName', App.name);
    $('#myName').value = App.name;
    $('#myAvatar').textContent = (App.name[0] || '?').toUpperCase();
    LocalBus.setName(App.name);
    for (const id in App.peers) sendFrame(id, { t: 'name', name: App.name });
  });
  $('#myId').addEventListener('click', () => copyText(App.id));
  $('#btnInvite').onclick = () => openModal('modalPair');
  $('#pairClose').onclick = () => closeModal('modalPair');
  $('#btnInstall').onclick = async () => {
    if (!window.__installEvt) return;
    window.__installEvt.prompt();
    window.__installEvt = null;
    $('#btnInstall').hidden = true;
  };

  $$('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  $('#btnMakeOffer').onclick = async () => {
    try {
      pendingRtc = new RtcLink();
      $('#btnMakeOffer').disabled = true;
      $('#pairStateCreate').textContent = 'Собираем код (до 3 секунд)…';
      const code = await pendingRtc.createOffer(App.id, App.name);
      $('#offerOut').value = code;
      $('#pairStateCreate').textContent = 'Код готов — передайте его собеседнику';
    } catch (e) { $('#pairStateCreate').textContent = 'Ошибка: ' + e.message; }
    $('#btnMakeOffer').disabled = false;
  };
  $('#btnCopyOffer').onclick = () => copyText($('#offerOut').value);
  $('#btnCopyOfferLink').onclick = () => copyText(location.href.split('#')[0] + '#o=' + encodeURIComponent($('#offerOut').value));
  $('#btnAcceptAnswer').onclick = async () => {
    if (!pendingRtc) { toast('Сначала создайте код приглашения'); return; }
    try {
      const r = await pendingRtc.acceptAnswer($('#answerIn').value);
      attachLink(r.peerId, r.peerName, pendingRtc);
      pendingRtc = null;
      $('#pairStateCreate').textContent = 'Устанавливаем соединение…';
    } catch (e) { $('#pairStateCreate').textContent = 'Ошибка: ' + e.message; }
  };

  $('#btnMakeAnswer').onclick = async () => {
    try {
      const link = new RtcLink();
      const r = await link.acceptOffer($('#offerIn').value, App.id, App.name);
      $('#answerOut').value = r.answer;
      attachLink(r.peerId, r.peerName, link);
      $('#pairStateAccept').textContent = 'Ответ создан — передайте код обратно и дождитесь соединения';
    } catch (e) { $('#pairStateAccept').textContent = 'Ошибка: ' + e.message; }
  };
  $('#btnCopyAnswer').onclick = () => copyText($('#answerOut').value);
  $('#btnCopyAnswerLink').onclick = () => copyText(location.href.split('#')[0] + '#a=' + encodeURIComponent($('#answerOut').value));

  $('#btnBack').onclick = () => {
    document.body.classList.remove('chat-open');
    App.activePeer = null;
    $('#chat').hidden = true; $('#empty').hidden = false;
    renderChatList();
  };
  $('#btnSend').onclick = sendText;
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  $('#input').addEventListener('input', autoSize);

  $('#btnAttach').onclick = () => $('#fileInput').click();
  $('#fileInput').addEventListener('change', onFiles);
  $('#btnMic').onclick = startVoiceRec;
  $('#btnRecVoiceStop').onclick = () => stopVoiceRec(false);
  $('#btnRecVoiceCancel').onclick = () => stopVoiceRec(true);

  $('#btnCam').onclick = openCam;
  $('#camClose').onclick = () => closeCam();
  $('#btnRecVideo').onclick = startVideoRec;
  $('#btnRecStop').onclick = stopVideoRec;
  $('#btnRecSend').onclick = sendVideoRec;
  $('#btnRecCancel').onclick = () => closeCam();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('modalPair');
      if (!$('#modalCam').hidden) closeCam();
    }
  });

  renderLocalPeers();
}

function switchTab(name) {
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  ['create', 'accept', 'local'].forEach(n => { $('#tab-' + n).hidden = (n !== name); });
}

function renderLocalPeers() {
  const box = $('#localPeers'); if (!box) return;
  const list = LocalBus.list();
  box.innerHTML = '';
  const free = list.filter(p => !(App.peers[p.id] && App.peers[p.id].link));
  if (!free.length) {
    box.innerHTML = '<div class="small">' +
      (list.length ? 'Все найденные окна уже соединены.' :
      'Окна не найдены. Откройте приложение во втором окне этого браузера — оно появится здесь.') +
      '</div>';
    return;
  }
  for (const p of free) {
    const b = document.createElement('button');
    b.className = 'btn wide';
    b.textContent = '💬 ' + p.name + '  (' + p.id + ')';
    b.onclick = () => LocalBus.connect(p.id, p.name);
    box.appendChild(b);
  }
}

function handleHashInvite() {
  const h = location.hash;
  if (!h.startsWith('#o=') && !h.startsWith('#a=')) return;
  openModal('modalPair');
  if (h.startsWith('#o=')) {
    switchTab('accept');
    $('#offerIn').value = decodeURIComponent(h.slice(3));
    $('#btnMakeAnswer').click();
  } else {
    switchTab('create');
    $('#answerIn').value = decodeURIComponent(h.slice(3));
    if (pendingRtc) $('#btnAcceptAnswer').click();
    else toast('Сначала нажмите «Создать код приглашения», затем вставьте ответ');
  }
  history.replaceState(null, '', location.pathname + location.search);
}

/* ---------- Запись: голос ---------- */
let rec = null, recStream = null, recChunks = [], recTimer = null, recCancelled = false, recStart = 0, recKind = null;

function pickMime(kind) {
  const list = kind === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
  return '';
}

async function startVoiceRec() {
  const pid = App.activePeer; if (!pid) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Запись не поддерживается этим браузером'); return; }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('Нет доступа к микрофону'); return; }
  recKind = 'audio'; recChunks = []; recCancelled = false;
  const mime = pickMime('audio');
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = onRecStop;
  rec.start(250);
  recStart = Date.now();
  $('#composer').hidden = true; $('#recBar').hidden = false;
  recTimer = setInterval(() => {
    $('#recTime').textContent = fmtRec(Date.now() - recStart);
    if (Date.now() - recStart > 120000) stopVoiceRec(false);
  }, 250);
}
function fmtRec(ms) { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function stopVoiceRec(cancel) {
  recCancelled = cancel;
  if (rec && rec.state !== 'inactive') rec.stop(); else cleanupRec();
}
function cleanupRec() {
  clearInterval(recTimer);
  if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
  rec = null;
  $('#recBar').hidden = true; $('#composer').hidden = false;
}
function onRecStop() {
  const pid = App.activePeer;
  const type = (rec && rec.mimeType) || 'audio/webm';
  const blob = new Blob(recChunks, { type });
  cleanupRec();
  if (recCancelled || !blob.size || !pid) return;
  sendBlobMsg(pid, blob, 'voice', { mime: type });
}

/* ---------- Запись: видео ---------- */
let camStream = null, camRec = null, camBlob = null;

async function openCam() {
  const pid = App.activePeer; if (!pid) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Запись не поддерживается этим браузером'); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 } }, audio: true
    });
  } catch (e) { toast('Нет доступа к камере'); return; }
  camBlob = null;
  $('#camPreview').srcObject = camStream;
  $('#camPreview').muted = true;
  openModal('modalCam');
  $('#btnRecVideo').hidden = false; $('#btnRecStop').hidden = true;
  $('#btnRecSend').hidden = true; $('#btnRecCancel').hidden = true;
  $('#camState').textContent = '';
}
function startVideoRec() {
  const mime = pickMime('video');
  try { camRec = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined); }
  catch (e) { toast('Не удалось начать запись'); return; }
  recChunks = []; recCancelled = false;
  camRec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  camRec.onstop = () => {
    camBlob = new Blob(recChunks, { type: camRec.mimeType || 'video/webm' });
    $('#camPreview').srcObject = null;
    $('#camPreview').src = URL.createObjectURL(camBlob);
    $('#camPreview').muted = false;
    $('#camPreview').play().catch(() => {});
    $('#btnRecSend').hidden = false; $('#btnRecCancel').hidden = false;
    $('#camState').textContent = 'Готово: ' + fmtSize(camBlob.size);
  };
  camRec.start(250);
  $('#btnRecVideo').hidden = true; $('#btnRecStop').hidden = false;
  $('#camState').textContent = 'Запись… (максимум 60 секунд)';
  camTimer = setTimeout(stopVideoRec, 60000);
}
function stopVideoRec() {
  clearTimeout(camTimer);
  if (camRec && camRec.state !== 'inactive') camRec.stop();
}
function sendVideoRec() {
  if (camBlob && App.activePeer) sendBlobMsg(App.activePeer, camBlob, 'video', { mime: camBlob.type });
  closeCam();
}
function closeCam() {
  clearTimeout(camTimer);
  if (camRec && camRec.state !== 'inactive') { recCancelled = true; try { camRec.stop(); } catch (e) {} }
  camRec = null;
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  const v = $('#camPreview');
  v.srcObject = null; v.src = ''; v.muted = true;
  closeModal('modalCam');
}

/* ---------- Файлы ---------- */
async function onFiles(e) {
  const pid = App.activePeer; if (!pid) return;
  for (const f of e.target.files) {
    const kind = f.type && f.type.startsWith('image/') ? 'image' : 'file';
    await sendBlobMsg(pid, f, kind, { name: f.name, mime: f.type || 'application/octet-stream' });
  }
  e.target.value = '';
}

/* ---------- Мелочи ---------- */
function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }
function toast(s) {
  const t = $('#toast');
  t.textContent = s; t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function copyText(s) {
  if (!s) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(s).then(() => toast('Скопировано'), () => toast('Не удалось скопировать — выделите текст вручную'));
  } else toast('Скопируйте текст вручную');
}
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); setTimeout(() => { try { o.stop(); } catch (e) {} }, 120);
  } catch (e) {}
}
function flashTitle() {
  const n = Object.values(App.peers).reduce((s, p) => s + (p.unread || 0), 0);
  document.title = (n ? '(' + n + ') ' : '') + 'ФениксЧат';
}
function autoSize() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  window.__installEvt = e;
  $('#btnInstall').hidden = false;
});

window.addEventListener('beforeunload', () => {
  for (const id in App.peers) {
    try { App.peers[id].link && App.peers[id].link.close(); } catch (e) {}
  }
  try { LocalBus.stop(); } catch (e) {}
});

init();
