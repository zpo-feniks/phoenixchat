'use strict';
/* ФениксЧат — транспортный уровень.
   RtcLink:   WebRTC DataChannel, шифрование DTLS, ручной обмен кодами (без сервера сигнализации).
   LocalBus / LocalLink: окна одного браузера (BroadcastChannel) — демо и работа в двух окнах.
   Протокол кадров поверх канала:
     строки JSON: {t:'msg'|'read'|'ping'|'pong'|'name'|'bin'|'bin-end'}
     бинарные кадры: куски Blob по 16 КиБ между 'bin' и 'bin-end' (канал упорядоченный).
*/

window.addEventListener('error', e => { (window.__errs = window.__errs || []).push(String(e.message)); });
window.addEventListener('unhandledrejection', e => { (window.__errs = window.__errs || []).push('rej: ' + String(e.reason)); });

const CHUNK = 16 * 1024;

function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64d(s) { return decodeURIComponent(escape(atob(s.trim()))); }
function rid(n) {
  n = n || 8;
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = new Uint8Array(n);
  crypto.getRandomValues(r);
  let s = '';
  for (let i = 0; i < n; i++) s += a[r[i] % a.length];
  return s;
}

/* ---------- Базовый канал: кадры JSON + куски Blob ---------- */
class FrameLink {
  constructor() {
    this.onframe = null;   // кадр JSON или {t:'blob', meta, blob}
    this.onstate = null;   // 'open' | 'closed'
    this.open = false;
    this._lock = Promise.resolve();
    this._curId = null; this._curMeta = null; this._curParts = null;
  }
  sendText(obj) { this._raw(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  sendBlob(blob, meta) {
    const run = this._lock.then(() => this._sendBlob(blob, meta));
    this._lock = run.catch(() => {});
    return run;
  }
  async _sendBlob(blob, meta) {
    const total = Math.max(1, Math.ceil(blob.size / CHUNK));
    this._raw(JSON.stringify(Object.assign({ t: 'bin', size: blob.size, chunks: total }, meta)));
    for (let i = 0; i < total; i++) {
      const buf = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
      await this._drain();
      this._raw(buf);
    }
    this._raw(JSON.stringify({ t: 'bin-end', id: meta.id }));
  }
  handle(m) {
    if (typeof m === 'string') {
      let f; try { f = JSON.parse(m); } catch (e) { return; }
      if (f.t === 'bin') { this._curId = f.id; this._curMeta = f; this._curParts = []; return; }
      if (f.t === 'bin-end') {
        if (this._curId === f.id && this._curParts) {
          const blob = new Blob(this._curParts);
          this.onframe && this.onframe({ t: 'blob', meta: this._curMeta, blob });
        }
        this._curId = null; this._curParts = null; this._curMeta = null;
        return;
      }
      this.onframe && this.onframe(f);
    } else if (m instanceof ArrayBuffer) {
      if (this._curParts) this._curParts.push(m);
    }
  }
}

/* ---------- WebRTC ---------- */
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

class RtcLink extends FrameLink {
  constructor() {
    super();
    this._pc = new RTCPeerConnection(ICE);
    this._dc = null;
  }
  _raw(m) { if (this._dc && this._dc.readyState === 'open') this._dc.send(m); }
  _drain() {
    const dc = this._dc;
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount < 512 * 1024) return Promise.resolve();
    return new Promise(res => {
      const iv = setInterval(() => {
        if (!this._dc || this._dc.readyState !== 'open' || this._dc.bufferedAmount < 512 * 1024) { clearInterval(iv); res(); }
      }, 30);
    });
  }
  _attach(dc) {
    this._dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { this.open = true; this.onstate && this.onstate('open'); };
    dc.onclose = () => { this.open = false; this.onstate && this.onstate('closed'); };
    dc.onmessage = e => this.handle(e.data);
  }
  async createOffer(myId, myName) {
    this._attach(this._pc.createDataChannel('chat', { ordered: true }));
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitIce();
    return 'FCHAT-O-' + b64e(JSON.stringify({ v: 1, id: myId, name: myName, s: this._pc.localDescription }));
  }
  async acceptOffer(code, myId, myName) {
    const d = this._decode(code, 'FCHAT-O-');
    this._pc.ondatachannel = e => this._attach(e.channel);
    await this._pc.setRemoteDescription(d.s);
    const ans = await this._pc.createAnswer();
    await this._pc.setLocalDescription(ans);
    await this._waitIce();
    return {
      peerId: d.id, peerName: d.name,
      answer: 'FCHAT-A-' + b64e(JSON.stringify({ v: 1, id: myId, name: myName, s: this._pc.localDescription }))
    };
  }
  async acceptAnswer(code) {
    const d = this._decode(code, 'FCHAT-A-');
    await this._pc.setRemoteDescription(d.s);
    return { peerId: d.id, peerName: d.name };
  }
  _decode(code, prefix) {
    code = (code || '').replace(/\s+/g, '');
    if (!code.startsWith(prefix)) throw new Error('Неверный формат кода (ожидается ' + prefix + '…)');
    return JSON.parse(b64d(code.slice(prefix.length)));
  }
  _waitIce() {
    return new Promise(res => {
      if (this._pc.iceGatheringState === 'complete') return res();
      const done = () => { clearTimeout(t); res(); };
      const t = setTimeout(done, 3000);
      this._pc.addEventListener('icegatheringstatechange', () => {
        if (this._pc.iceGatheringState === 'complete') done();
      });
    });
  }
  close() {
    try { this._dc && this._dc.close(); } catch (e) {}
    try { this._pc.close(); } catch (e) {}
    this.open = false;
  }
}

/* ---------- Локальная шина (окна одного браузера) ---------- */
const LocalBus = {
  ch: null, me: null, peers: new Map(), links: new Map(),
  onpeers: null, onlink: null, started: false,
  start(myTab) {
    if (this.started) return;
    this.started = true;
    this.me = myTab;
    this.ch = new BroadcastChannel('phoenixchat-bus');
    this.ch.onmessage = e => this._in(e.data);
    this._post({ t: 'hello', id: myTab.id, name: myTab.name });
    this._helloTimer = setInterval(() => this._post({ t: 'hello', id: this.me.id, name: this.me.name }), 2500);
    this._pruneTimer = setInterval(() => {
      const now = Date.now(); let ch = false;
      for (const [k, p] of this.peers) if (now - p.ts > 7000) { this.peers.delete(k); ch = true; }
      if (ch) this.onpeers && this.onpeers(this.list());
    }, 3000);
  },
  setName(name) { this.me.name = name; this._post({ t: 'hello', id: this.me.id, name }); },
  list() { return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name)); },
  _post(m) { try { this.ch.postMessage(m); } catch (e) {} },
  connect(peerId, peerName) {
    let link = this.links.get(peerId);
    if (link) return link;
    link = new LocalLink(this, peerId);
    this.links.set(peerId, link);
    this._post({ t: 'link', to: peerId, from: this.me.id, name: this.me.name });
    this.onlink && this.onlink(link, peerId, peerName || null);
    return link;
  },
  _in(m) {
    if (!m || !m.t) return;
    if (m.t === 'hello') {
      if (m.id === this.me.id) return;
      this.peers.set(m.id, { id: m.id, name: m.name, ts: Date.now() });
      this.onpeers && this.onpeers(this.list());
      return;
    }
    if (m.t === 'bye') { this.peers.delete(m.id); this.onpeers && this.onpeers(this.list()); return; }
    if (m.to !== this.me.id) return;
    if (m.t === 'link') {
      let link = this.links.get(m.from);
      if (!link) {
        link = new LocalLink(this, m.from);
        this.links.set(m.from, link);
        link.open = true;
      }
      this._post({ t: 'link-ok', to: m.from, from: this.me.id, name: this.me.name });
      this.onlink && this.onlink(link, m.from, m.name);
      return;
    }
    if (m.t === 'link-ok') {
      const link = this.links.get(m.from);
      if (link) { link.open = true; link.onstate && link.onstate('open'); }
      this.onlink && this.onlink(link, m.from, m.name);
      return;
    }
    if (m.t === 'd') {
      const link = this.links.get(m.from);
      if (link) link.handle(m.d);
    }
  },
  stop() {
    clearInterval(this._helloTimer); clearInterval(this._pruneTimer);
    this._post({ t: 'bye', id: this.me.id });
    try { this.ch && this.ch.close(); } catch (e) {}
  }
};

class LocalLink extends FrameLink {
  constructor(bus, peerId) { super(); this._bus = bus; this._peer = peerId; }
  _raw(m) { this._bus._post({ t: 'd', to: this._peer, from: this._bus.me.id, d: m }); }
  _drain() { return Promise.resolve(); }
  close() {
    this.open = false;
    this._bus.links.delete(this._peer);
    this.onstate && this.onstate('closed');
  }
}
