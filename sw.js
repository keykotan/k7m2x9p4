// 旅行ハンドブック ／ オフライン保存の仕掛け
//
// 一度読み込んだアプリ本体を端末に保存し、以降は通信せずに開く。
// 電波の弱い場所や、回線が通らない時間帯でも必ず開くことが目的。
//
// 版の更新は自動では行わない。アプリの「更新する」ボタンから
// refresh の指示が来たときだけ、保存を取り直す。
// 旅行中に勝手に読み直して開けなくなるのを防ぐため。

const CACHE = 'trip-app-v1';

// キャッシュの鍵は、スコープの入口（…/ もしくは …/index.html）に正規化する。
// 同じページが別の鍵で二重に保存されるのを避ける。
const KEY = new URL('./', self.registration.scope).href;

// putPage より先に定義が必要なので、宣言を上に置く
//
// 壊れた本体を保存しないための関門。
// 回線が途中で切れると、200 のまま尻切れの HTML が返ることがある。
// それを保存すると以後ずっとそれを返し、白画面から抜けられなくなる。
// 末尾が </html> で閉じていて、十分な大きさがあることを確かめてから保存する。
async function looksComplete(res) {
  try {
    const t = await res.clone().text();
    if (t.length < 200000) return false;          // 本体は数MBある。極端に小さければ異常
    return /<\/html>\s*$/i.test(t.slice(-4000));  // 末尾が閉じているか
  } catch (e) {
    return false;
  }
}

async function putPage(res) {
  if (!(await looksComplete(res))) return false;   // 保存しない。古い保存を残す
  const c = await caches.open(CACHE);
  await c.put(KEY, res.clone());
  return true;
}

self.addEventListener('install', (e) => {
  // ここで本体を保存しておく。
  // fetch の取りこぼしを待つと2回目の読み込みまで保存されず、
  // 「一度開けばオフラインで使える」が成立しない。
  e.waitUntil((async () => {
    try {
      const r = await fetch(KEY, { cache: 'reload' });
      if (r && r.ok) await putPage(r);
    } catch (err) { /* 取れなくても、次の読み込みで保存される */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 古い世代のキャッシュを片付ける
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // version.txt は常にネットを見る。保存しない。
  // 保存すると新しい版に気づけなくなる。
  if (url.pathname.endsWith('/version.txt')) return;

  // 同じ場所のアプリ本体だけを扱う。外部（地図・公式サイト）は素通し。
  if (url.origin !== location.origin) return;

  const isPage = req.mode === 'navigate' ||
    (req.destination === 'document') ||
    url.href === KEY ||
    url.href === KEY + 'index.html';
  if (!isPage) return;

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(KEY);
    // 保存があれば、まずそれを返す。通信の状態に一切依存しない。
    if (hit) return hit;
    // 初回だけネットから取り、保存する。
    const res = await fetch(req);
    if (res && res.ok) await putPage(res);
    return res;
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  const reply = (msg) => {
    if (e.ports && e.ports[0]) e.ports[0].postMessage(msg);
  };

  if (d.type === 'refresh') {
    // アプリの「更新する」ボタンから呼ばれる。
    // 新しい本体を取り直してから保存を差し替える。
    // 取れなかった場合は古い保存をそのまま残す（開けなくなるのを防ぐ）。
    e.waitUntil((async () => {
      try {
        const res = await fetch(KEY + '?t=' + Date.now(), { cache: 'reload' });
        if (!res || !res.ok) { reply({ ok: false, why: 'http' }); return; }
        // 尻切れの本体は保存しない。この場合も失敗として返す。
        const ok = await putPage(res);
        reply(ok ? { ok: true } : { ok: false, why: 'partial' });
      } catch (err) {
        reply({ ok: false, why: 'offline' });
      }
    })());
    return;
  }

  if (d.type === 'saved') {
    // 保存できているかの問い合わせ
    e.waitUntil((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(KEY);
      reply({ saved: !!hit });
    })());
  }
});
