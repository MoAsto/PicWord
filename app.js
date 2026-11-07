'use strict';
/* =====================================================================
 * 単語帳アプリ
 *  - 学習データはまず端末(localStorage)に保存し、設定されていれば
 *    Google Apps Script 経由で Googleスプレッドシートと同期します。
 *  - APIのURLと合言葉(TOKEN)はソースに含めず、設定画面から端末内に保存します。
 * ===================================================================== */
(() => {
  // ---------------------------------------------------------------- ヘルパー
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const z2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;
  const today = () => ymd(new Date());
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diffDays = (a, b) => {
    const A = parseYmd(a), B = parseYmd(b);
    return Math.round((Date.UTC(A.getFullYear(), A.getMonth(), A.getDate()) - Date.UTC(B.getFullYear(), B.getMonth(), B.getDate())) / 864e5);
  };
  const uid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let toastTimer = null;
  function toast(msg, kind = '', ms = 3200) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, ms);
  }
  const toastErr = (msg) => toast(msg, 'err', 6000);

  // ---------------------------------------------------------------- 状態と保存
  const LS_STATE = 'vocab_state_v1';
  const LS_CFG = 'vocab_cfg_v1';
  const defState = () => ({
    v: 1,
    words: {},                       // id -> 単語
    history: [],                     // 学習履歴
    pend: { w: {}, d: {}, h: {} },   // 未同期（単語 / 削除 / 履歴）
    settings: { showJa: true, newCount: 10, includeReview: true },
    cursor: { since: 0, hist: 0 },
  });

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const o = JSON.parse(raw);
        const d = defState();
        return Object.assign(d, o, {
          settings: Object.assign(d.settings, o.settings || {}),
          pend: Object.assign(d.pend, o.pend || {}),
          cursor: Object.assign(d.cursor, o.cursor || {}),
        });
      }
    } catch (e) {
      console.error(e);
      try { localStorage.setItem('vocab_state_corrupt_backup', raw); } catch (_) { /* ignore */ }
    }
    return defState();
  }
  let S = loadState();
  let saveErrShown = false;
  function save() {
    try {
      if (S.history.length > 4000) S.history = S.history.slice(-4000);
      localStorage.setItem(LS_STATE, JSON.stringify(S));
      saveErrShown = false;
    } catch (e) {
      if (!saveErrShown) {
        saveErrShown = true;
        toastErr('この端末に保存できませんでした（容量不足の可能性）。画像が多い場合はGoogleスプレッドシート連携をおすすめします。');
      }
    }
  }
  const getCfg = () => { try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch (_) { return {}; } };
  const setCfg = (c) => localStorage.setItem(LS_CFG, JSON.stringify(c));
  const isCloud = () => { const c = getCfg(); return !!(c.url && c.token); };
  const markPend = (id) => { S.pend.w[id] = true; delete S.pend.d[id]; };
  const pendCount = () => Object.keys(S.pend.w).length + Object.keys(S.pend.d).length + Object.keys(S.pend.h).length;

  // ---------------------------------------------------------------- 復習アルゴリズム
  // 習熟度 Lv0〜5。Lv n に到達したときの基本間隔（日）。
  const BASE = [0, 1, 3, 7, 14, 30];
  const MASTER = 5;      // Lv5以上を「覚えた」とする
  const MAX_INTERVAL = 180;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function createWord(word, ja, img, created) {
    const t = created || Date.now();
    return {
      id: 'w' + t.toString(36) + Math.random().toString(36).slice(2, 7),
      word, ja: ja || '', img: img || '',
      study: 0, ok: 0, ng: 0, last: '', next: '', level: 0, interval: 0, ease: 2.5, lapses: 0,
      created: t, updated: 0, mtime: t,
    };
  }

  /** 回答結果を反映した新しい単語オブジェクトを返す（純粋関数） */
  function reviewWord(w, correct, relearn, t = today()) {
    const n = { ...w };
    n.study = (w.study || 0) + 1;
    n.last = t;
    if (correct) {
      n.ok = (w.ok || 0) + 1;
      n.ease = +clamp((w.ease || 2.5) + 0.1, 1.3, 2.5).toFixed(2); // 正解で標準(2.5)へ回復。2.5を超えない
      let interval;
      if (relearn) {
        // 同じ学習中に一度間違えた単語：習熟度は上げず、翌日にもう一度確認
        n.level = Math.max(1, w.level);
        interval = 1;
      } else if (w.level >= MASTER) {
        // 十分に覚えた単語：間隔を伸ばして出題頻度を下げる
        n.level = MASTER;
        interval = clamp(Math.round(Math.max(w.interval || 30, 30) * (n.ease / 2.5) * 1.6), 30, MAX_INTERVAL);
      } else {
        n.level = w.level + 1;
        const mult = clamp(n.ease / 2.5, 0.7, 1.3);
        interval = Math.max(1, Math.round(BASE[n.level] * mult));
      }
      n.interval = interval;
      n.next = addDays(t, interval);
    } else {
      n.ng = (w.ng || 0) + 1;
      n.lapses = (w.lapses || 0) + 1;
      n.ease = +clamp((w.ease || 2.5) - 0.2, 1.3, 3.0).toFixed(2);
      n.level = Math.max(0, w.level - 2);
      n.interval = 0;
      n.next = t; // 当日中に再出題対象
    }
    return n;
  }

  /** 出題優先度（大きいほど先） */
  function priority(w, t) {
    const over = Math.max(0, diffDays(t, w.next));
    return over * 2
      + (w.interval === 0 && w.study > 0 ? 10 : 0)   // 直前に間違えて再学習待ち
      + (w.lapses > 0 ? 5 : 0)                       // 過去に間違えた
      + (w.ng > w.ok ? 2 : 0)
      + Math.max(0, 3 - w.level) * 0.5;
  }

  function dueWords(t = today()) {
    return Object.values(S.words).filter((w) => w.study > 0 && w.next && w.next <= t);
  }
  function buildQueue(opts) {
    const t = today();
    const due = opts.includeReview ? dueWords(t).sort((a, b) => priority(b, t) - priority(a, t) || a.created - b.created) : [];
    const news = Object.values(S.words).filter((w) => w.study === 0).sort((a, b) => a.created - b.created).slice(0, Math.max(0, opts.newCount));
    return [...due, ...news].map((w) => w.id);
  }

  const wordStatus = (w, t) => (w.study === 0 ? 'new' : w.level >= MASTER ? 'mastered' : w.next && w.next < t ? 'overdue' : 'learning');
  function relLabel(w, t) {
    if (!w.study || !w.next) return '未学習';
    const d = diffDays(w.next, t);
    if (d < 0) return `${-d}日超過`;
    if (d === 0) return '今日';
    if (d === 1) return '明日';
    return `${d}日後`;
  }

  function computeStats() {
    const t = today();
    const ws = Object.values(S.words);
    const st = { total: ws.length, mastered: 0, dueToday: 0, overdue: 0, news: 0, ok: 0, ng: 0, learnedToday: 0 };
    ws.forEach((w) => {
      st.ok += w.ok || 0; st.ng += w.ng || 0;
      if (w.study === 0) { st.news++; return; }
      if (w.level >= MASTER) st.mastered++;
      if (w.next === t) st.dueToday++;
      else if (w.next && w.next < t) st.overdue++;
    });
    st.learnedToday = new Set(S.history.filter((h) => h.date === t).map((h) => h.wid)).size;
    return st;
  }

  // ---------------------------------------------------------------- 画像
  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    const m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
    if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1600`;
    if (!/^https?:\/\//i.test(u) && !u.startsWith('data:image/')) throw new Error('画像のURLは http:// または https:// で始まる必要があります');
    return u;
  }
  function fileToDataURL(file, max, q) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, max / Math.max(im.width, im.height));
        const w = Math.max(1, Math.round(im.width * sc)), h = Math.max(1, Math.round(im.height * sc));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
        x.drawImage(im, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', q));
      };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読み込めませんでした。別の画像でお試しください。')); };
      im.src = url;
    });
  }

  // ---------------------------------------------------------------- 通信（Apps Script）
  class AppError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  const SERVER_MSG = {
    unauthorized: '合言葉（TOKEN）が一致しません。設定画面で確認してください。',
    token_not_set: 'Apps Script側に TOKEN が設定されていません。README の手順を確認してください。',
    unknown_action: 'Apps Script のコードが古い可能性があります。最新の Code.gs を貼り付けて再デプロイしてください。',
  };
  async function api(payload, timeoutMs = 40000) {
    const c = getCfg();
    if (!c.url || !c.token) throw new AppError('config', 'Googleスプレッドシート連携が設定されていません。');
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライトを避けるため text/plain
        body: JSON.stringify({ ...payload, token: c.token }),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      text = await res.text();
    } catch (e) {
      throw new AppError('network', e.name === 'AbortError'
        ? '通信がタイムアウトしました。電波の良い場所で再試行してください。'
        : 'サーバーに接続できません（オフライン、またはURLが間違っている可能性があります）。学習記録はこの端末に保存済みで、接続できれば自動的に同期されます。');
    } finally { clearTimeout(to); }
    let j;
    try { j = JSON.parse(text); } catch (_) {
      throw new AppError('format', 'Apps Script から想定外の応答がありました。URLが「/exec」で終わっているか、デプロイの「アクセスできるユーザー」が「全員」になっているか確認してください。');
    }
    if (!j.ok) throw new AppError('server', SERVER_MSG[j.error] || `サーバーエラー: ${j.error}`);
    return j;
  }

  async function uploadImage(dataUrl, name) {
    const i = dataUrl.indexOf(',');
    const mime = (/^data:([^;]+);/.exec(dataUrl.slice(0, i)) || [])[1] || 'image/jpeg';
    const r = await api({ action: 'uploadImage', name: (name || 'image').replace(/[^\w-]+/g, '_'), mime, data: dataUrl.slice(i + 1) }, 90000);
    return r.url;
  }

  // ---------------------------------------------------------------- 同期
  let syncing = false, syncAgain = false, syncTimer = null, syncState = 'idle', lastError = '', lastToasted = '';
  const WORD_KEYS = ['id', 'word', 'ja', 'img', 'study', 'ok', 'ng', 'last', 'next', 'level', 'interval', 'ease', 'lapses', 'created'];
  const pickWord = (w) => Object.fromEntries(WORD_KEYS.map((k) => [k, w[k]]));

  function scheduleSync(ms = 1500) {
    if (!isCloud()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync(false), ms);
  }

  async function migrateImages() {
    for (const id of Object.keys(S.pend.w)) {
      const w = S.words[id];
      if (w && w.img && w.img.startsWith('data:')) {
        w.img = await uploadImage(w.img, w.word);
        w.mtime = Date.now();
        save();
      }
    }
  }

  function mergeServer(resp) {
    const ids = new Set(resp.ids);
    for (const sw of resp.words) {
      if (S.pend.d[sw.id]) continue;                // 端末で削除済み（送信待ち）
      if (S.pend.w[sw.id]) continue;                // 通信中に端末で更新された
      S.words[sw.id] = { ...sw, mtime: sw.updated };
    }
    for (const id of Object.keys(S.words)) {
      if (!ids.has(id) && !S.pend.w[id]) delete S.words[id]; // 他の端末で削除された
    }
    const have = new Set(S.history.map((h) => h.id));
    let added = false;
    for (const h of resp.history) if (!have.has(h.id)) { S.history.push(h); added = true; }
    if (added) S.history.sort((a, b) => a.ts - b.ts);
  }

  async function sync(manual) {
    if (!isCloud()) { renderSync(); return false; }
    if (syncing) { syncAgain = true; return false; }
    syncing = true; syncState = 'syncing'; renderSync();
    let ok = false;
    try {
      await migrateImages();
      const sentM = {}, words = [];
      for (const id of Object.keys(S.pend.w)) {
        const w = S.words[id];
        if (w) { words.push(pickWord(w)); sentM[id] = w.mtime; } else delete S.pend.w[id];
      }
      const dels = Object.keys(S.pend.d);
      const hmap = new Map(S.history.map((h) => [h.id, h]));
      const hist = [];
      for (const id of Object.keys(S.pend.h)) { const h = hmap.get(id); if (h) hist.push(h); else delete S.pend.h[id]; }

      const resp = await api({ action: 'sync', words, deletes: dels, history: hist, since: S.cursor.since, hsince: S.cursor.hist });

      for (const w of words) { const loc = S.words[w.id]; if (!loc || loc.mtime === sentM[w.id]) delete S.pend.w[w.id]; }
      dels.forEach((id) => delete S.pend.d[id]);
      hist.forEach((h) => delete S.pend.h[h.id]);
      mergeServer(resp);
      S.cursor.since = resp.now;
      S.cursor.hist = resp.hcursor;
      save();
      syncState = 'idle'; lastError = ''; lastToasted = ''; ok = true;
      if (manual) toast('同期しました');
    } catch (e) {
      syncState = 'error';
      lastError = e.message || String(e);
      if (manual || lastToasted !== lastError) toastErr(lastError);
      lastToasted = lastError;
    } finally {
      syncing = false;
      renderSync();
      refreshCurrentView();
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
    return ok;
  }

  function renderSync() {
    const el = $('#syncChip');
    if (!el) return;
    let txt, cls = 'chip';
    if (!isCloud()) { txt = 'この端末のみ'; cls += ' warn'; }
    else if (syncState === 'syncing') txt = '同期中…';
    else if (syncState === 'error') { txt = '同期エラー（タップで再試行）'; cls += ' err'; }
    else if (pendCount() > 0) { txt = `未同期 ${pendCount()}件`; cls += ' warn'; }
    else { txt = '同期済み'; cls += ' ok'; }
    el.textContent = txt; el.className = cls;
  }

  // ---------------------------------------------------------------- 画面遷移
  let view = 'home';
  function go(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + name));
    view = name;
    document.body.dataset.view = name;
    document.body.classList.toggle('has-nav', ['home', 'words', 'status', 'settings'].includes(name));
    $$('#tabbar [data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    window.scrollTo(0, 0);
    ({ home: renderHome, setup: renderSetup, status: renderStatus, words: renderWords, settings: renderSettings }[name] || (() => {}))();
  }
  function refreshCurrentView() {
    if ($('dialog[open]')) return;
    if (view === 'home') renderHome();
    else if (view === 'words') renderWords(true);
    else if (view === 'status') renderStatus();
    else if (view === 'settings') renderSettings();
  }

  // ---------------------------------------------------------------- ホーム
  function renderHome() {
    const st = computeStats();
    $('#tDue').textContent = st.dueToday;
    $('#tToday').textContent = st.learnedToday;
    $('#tOver').textContent = st.overdue;
    $('#tMaster').textContent = st.mastered;
    $('#tTotal').textContent = st.total;
    const b = [];
    if (st.total === 0) b.push('<div>単語がまだ登録されていません。「単語の管理」から追加してください。</div>');
    if (!isCloud()) b.push('<div class="warn">学習データはこの端末だけに保存されています。複数の端末で使うには、設定でGoogleスプレッドシートと連携してください。<br><button class="btn small" data-go="settings" type="button">設定を開く</button></div>');
    if (isCloud() && syncState === 'error') b.push(`<div class="err">${esc(lastError)}<br><button class="btn small" id="bnRetry" type="button">もう一度同期する</button></div>`);
    $('#banner').innerHTML = b.join('');
    $('#btnStart').disabled = st.total === 0;
    $('#heroSub').textContent = st.total === 0 ? '単語を登録して始めましょう'
      : `未学習の単語 ${st.news}語${st.overdue ? ` ・ 期限切れ ${st.overdue}語` : ''}`;
    renderSync();
  }

  // ---------------------------------------------------------------- 学習設定
  function renderSetup() {
    $('#optJa').checked = !!S.settings.showJa;
    $('#optNew').value = S.settings.newCount;
    $('#optRev').checked = !!S.settings.includeReview;
    updateSetupInfo();
  }
  function readSetup() {
    const n = clamp(parseInt($('#optNew').value, 10) || 0, 0, 500);
    return { showJa: $('#optJa').checked, newCount: n, includeReview: $('#optRev').checked };
  }
  function updateSetupInfo() {
    const o = readSetup();
    const st = computeStats();
    $$('#newChips .chip-btn').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === o.newCount));
    const rev = o.includeReview ? dueWords().length : 0;
    const nw = Math.min(o.newCount, st.news);
    $('#setupInfo').textContent = `今回の出題：復習 ${rev}語 ＋ 新規 ${nw}語（未学習 ${st.news}語）`;
    $('#btnGo').disabled = rev + nw === 0;
  }

  // ---------------------------------------------------------------- 学習セッション
  let sess = null;
  function startSession() {
    const o = readSetup();
    S.settings = o; save();
    const queue = buildQueue(o);
    if (!queue.length) { toastErr('出題できる単語がありません。新しい単語数を増やすか、単語を追加してください。'); return; }
    sess = { queue, total: queue.length, done: 0, ok: 0, ng: 0, cur: null, answered: false, relearn: new Set(), showJa: o.showJa };
    go('study');
    nextCard();
  }

  function setProgress() {
    $('#progBar').style.width = `${sess.total ? (sess.done / sess.total) * 100 : 0}%`;
    $('#progTxt').textContent = `${sess.done} / ${sess.total}`;
  }

  function nextCard() {
    if (!sess) return;
    if (!sess.queue.length) { finishSession(); return; }
    sess.cur = sess.queue.shift();
    sess.answered = false;
    const w = S.words[sess.cur];
    if (!w) { nextCard(); return; }
    $('#stWord').textContent = w.word;
    $('#stAns').classList.add('hidden');
    $('#stMain').classList.remove('revealed');
    $('#stChoose').classList.remove('hidden');
    $('#btnNext').classList.add('hidden');
    $('#stMain').scrollTop = 0;
    setProgress();
    // 次の画像を先読み
    const nx = S.words[sess.queue[0]];
    if (nx && nx.img && !nx.img.startsWith('data:')) { const p = new Image(); p.referrerPolicy = 'no-referrer'; p.src = nx.img; }
  }

  function answer(correct) {
    if (!sess || sess.answered) return;
    const id = sess.cur;
    const w = S.words[id];
    if (!w) { nextCard(); return; }
    sess.answered = true;
    const relearn = sess.relearn.has(id);
    const nw = reviewWord(w, correct, relearn);
    nw.mtime = Date.now();
    S.words[id] = nw;
    markPend(id);
    const h = { id: uid(), ts: Date.now(), date: today(), wid: id, word: nw.word, r: correct ? 1 : 0, lv: nw.level, iv: nw.interval };
    S.history.push(h);
    S.pend.h[h.id] = true;
    if (correct) { sess.relearn.delete(id); sess.done++; sess.ok++; }
    else { sess.relearn.add(id); sess.ng++; sess.queue.splice(Math.min(3, sess.queue.length), 0, id); } // 数枚後にもう一度出題
    save();
    scheduleSync(4000);
    setProgress();
    renderAnswer(nw);
  }

  function renderAnswer(w) {
    const img = $('#stImg'), err = $('#stImgErr'), ja = $('#stJa');
    err.classList.add('hidden');
    img.classList.remove('hidden');
    img.onerror = () => { img.classList.add('hidden'); err.textContent = '画像を読み込めませんでした（通信状況を確認してください）'; err.classList.remove('hidden'); };
    img.onload = () => { err.classList.add('hidden'); img.classList.remove('hidden'); };
    if (w.img) { img.src = w.img; }
    else { img.removeAttribute('src'); img.classList.add('hidden'); err.textContent = '画像が登録されていません'; err.classList.remove('hidden'); }
    if (sess.showJa && w.ja) { ja.textContent = w.ja; ja.classList.remove('hidden'); } else ja.classList.add('hidden');
    $('#stAns').classList.remove('hidden');
    $('#stMain').classList.add('revealed');
    $('#stChoose').classList.add('hidden');
    const nb = $('#btnNext');
    nb.textContent = sess.queue.length ? '次へ' : '終了';
    nb.classList.remove('hidden');
    nb.focus({ preventScroll: true });
  }

  function finishSession() {
    $('#dDone').textContent = sess.done;
    $('#dOk').textContent = sess.ok;
    $('#dNg').textContent = sess.ng;
    sess = null;
    go('done');
    scheduleSync(300);
  }
  function quitSession() { sess = null; go('home'); scheduleSync(300); }

  // ---------------------------------------------------------------- 単語管理
  const wordsUI = { q: '', f: 'all', limit: 60 };

  function itemHtml(w, t, detail) {
    const stt = wordStatus(w, t);
    const badge = stt === 'mastered' ? '<span class="st good">習得済み</span>' : stt === 'overdue' ? '<span class="st bad">期限切れ</span>' : '';
    const n = (w.ok || 0) + (w.ng || 0);
    const rate = w.study ? Math.round(((w.ok || 0) / Math.max(1, n)) * 100) : 0;
    const info = w.study
      ? [`Lv.${w.level}`, `次回 ${relLabel(w, t)}`, ...(detail ? [`正解率 ${rate}%（${w.ok || 0}/${n}）`] : [])].join(' ・ ')
      : '未学習';
    const thumb = w.img ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(w.img)}" alt="">` : '<span>画像なし</span>';
    return `<button class="item" type="button" data-id="${esc(w.id)}"><div class="thumb">${thumb}</div>
      <div class="meta"><div class="w">${esc(w.word)}</div>${w.ja ? `<div class="j">${esc(w.ja)}</div>` : ''}
      <div class="tags">${badge}<span>${esc(info)}</span></div></div><svg class="ic chev"><use href="#i-next"/></svg></button>`;
  }
  function bindThumbErrors(root) {
    $$('.thumb img', root).forEach((im) => im.addEventListener('error', () => { im.parentNode.innerHTML = '<span>読込不可</span>'; }, { once: true }));
  }

  function renderWords(keepLimit) {
    if (!keepLimit) wordsUI.limit = 60;
    const t = today();
    const q = wordsUI.q.trim().toLowerCase();
    let list = Object.values(S.words);
    if (wordsUI.f === 'noimg') list = list.filter((w) => !w.img);
    else if (wordsUI.f !== 'all') list = list.filter((w) => wordStatus(w, t) === wordsUI.f);
    if (q) list = list.filter((w) => w.word.toLowerCase().includes(q) || (w.ja || '').toLowerCase().includes(q));
    list.sort((a, b) => a.word.localeCompare(b.word, 'en', { sensitivity: 'base' }));
    $('#wCount').textContent = `${list.length}語（全${Object.keys(S.words).length}語）`;
    const el = $('#wList');
    if (!list.length) el.innerHTML = `<div class="empty">${Object.keys(S.words).length ? '該当する単語がありません' : '「＋ 単語を追加」から最初の単語を登録しましょう'}</div>`;
    else el.innerHTML = list.slice(0, wordsUI.limit).map((w) => itemHtml(w, t, false)).join('');
    bindThumbErrors(el);
    $('#wMore').classList.toggle('hidden', list.length <= wordsUI.limit);
  }

  // ---- 追加・編集ダイアログ
  const edit = { id: null, img: '' };
  const dlgWord = $('#dlgWord');
  const openDlg = (d) => { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
  const closeDlg = (d) => { if (d.close) d.close(); else d.removeAttribute('open'); };

  function dwMsg(t) { $('#dwMsg').textContent = t || ''; }
  function dwPreview() {
    const p = $('#dwPrev');
    if (edit.img) {
      p.innerHTML = `<img alt="プレビュー" referrerpolicy="no-referrer" src="${esc(edit.img)}">`;
      $('img', p).addEventListener('error', () => { p.innerHTML = '画像を読み込めません（URLを確認してください）'; }, { once: true });
    } else p.textContent = '画像なし';
  }
  function openEdit(id) {
    edit.id = id || null;
    const w = id ? S.words[id] : null;
    $('#dwTitle').textContent = w ? '単語を編集' : '単語を追加';
    $('#dwWord').value = w ? w.word : '';
    $('#dwJa').value = w ? w.ja : '';
    edit.img = w ? w.img : '';
    $('#dwUrl').value = edit.img && !edit.img.startsWith('data:') ? edit.img : '';
    $('#dwFile').value = '';
    $('#dwExtra').classList.toggle('hidden', !w);
    dwMsg('');
    dwPreview();
    openDlg(dlgWord);
    if (!w) setTimeout(() => $('#dwWord').focus(), 50);
  }
  async function setImageFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    dwMsg('画像を処理中…');
    try {
      edit.img = await fileToDataURL(file, isCloud() ? 1000 : 640, isCloud() ? 0.85 : 0.72);
      $('#dwUrl').value = '';
      dwMsg('');
      dwPreview();
    } catch (e) { dwMsg(e.message); }
  }

  let dwBusy = false;
  async function saveWordDlg() {
    if (dwBusy) return;
    const word = $('#dwWord').value.trim();
    if (!word) { dwMsg('英単語を入力してください'); return; }
    const ja = $('#dwJa').value.trim();
    const dup = Object.values(S.words).find((w) => w.id !== edit.id && w.word.toLowerCase() === word.toLowerCase());
    if (dup && !confirm(`「${word}」はすでに登録されています。重複して登録しますか？`)) return;
    let img = edit.img || '';
    dwBusy = true;
    $('#dwSave').disabled = true;
    try {
      if (img.startsWith('data:') && isCloud()) { dwMsg('画像をアップロード中…'); img = await uploadImage(img, word); }
    } catch (e) {
      dwMsg(`画像のアップロードに失敗しました：${e.message}`);
      dwBusy = false; $('#dwSave').disabled = false;
      return;
    }
    dwBusy = false; $('#dwSave').disabled = false;
    if (edit.id && S.words[edit.id]) {
      S.words[edit.id] = { ...S.words[edit.id], word, ja, img, mtime: Date.now() };
      markPend(edit.id);
    } else {
      const w = createWord(word, ja, img);
      S.words[w.id] = w;
      markPend(w.id);
    }
    save(); scheduleSync(500);
    closeDlg(dlgWord);
    refreshCurrentView();
    renderSync();
    toast('保存しました');
  }

  function deleteWord(id) {
    const w = S.words[id];
    if (!w || !confirm(`「${w.word}」を削除しますか？この操作は元に戻せません。`)) return;
    delete S.words[id];
    delete S.pend.w[id];
    S.pend.d[id] = true;
    save(); scheduleSync(500);
    closeDlg(dlgWord);
    refreshCurrentView(); renderSync();
    toast('削除しました');
  }
  function resetWord(id) {
    const w = S.words[id];
    if (!w || !confirm(`「${w.word}」の学習記録（回数・習熟度・復習予定）をリセットしますか？`)) return;
    S.words[id] = { ...w, study: 0, ok: 0, ng: 0, last: '', next: '', level: 0, interval: 0, ease: 2.5, lapses: 0, mtime: Date.now() };
    markPend(id);
    save(); scheduleSync(500);
    closeDlg(dlgWord);
    refreshCurrentView(); renderSync();
    toast('リセットしました');
  }

  // ---- まとめて追加
  const dlgBulk = $('#dlgBulk');
  function bulkAdd() {
    const lines = $('#bkText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { closeDlg(dlgBulk); return; }
    const exist = new Set(Object.values(S.words).map((w) => w.word.toLowerCase()));
    let added = 0, skipped = 0;
    const base = Date.now();
    lines.forEach((line, i) => {
      const m = line.match(/^(.+?)\s*[,\t，、]\s*(.*)$/);
      const word = (m ? m[1] : line).trim();
      const ja = m ? m[2].trim() : '';
      if (!word || exist.has(word.toLowerCase())) { skipped++; return; }
      exist.add(word.toLowerCase());
      const w = createWord(word, ja, '', base + i);
      S.words[w.id] = w; markPend(w.id); added++;
    });
    save(); scheduleSync(500);
    $('#bkText').value = '';
    closeDlg(dlgBulk);
    refreshCurrentView(); renderSync();
    toast(`${added}語を追加しました${skipped ? `（重複・空欄 ${skipped}件はスキップ）` : ''}`);
  }

  // ---------------------------------------------------------------- 学習状況
  const statusUI = { tab: 'overview', f: 'scheduled' };

  function renderStatus() {
    $$('#stTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === statusUI.tab));
    const body = $('#stBody');
    const t = today();
    const ws = Object.values(S.words);
    if (statusUI.tab === 'overview') {
      const st = computeStats();
      const tot = st.ok + st.ng;
      const rate = tot ? Math.round((st.ok / tot) * 100) : 0;
      const todayH = S.history.filter((h) => h.date === t);
      const tRate = todayH.length ? Math.round((todayH.filter((h) => h.r).length / todayH.length) * 100) : null;
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = addDays(t, -i);
        const hs = S.history.filter((h) => h.date === d);
        days.push({ d, n: hs.length, ok: hs.filter((h) => h.r).length });
      }
      const maxN = Math.max(1, ...days.map((x) => x.n));
      const bars = days.map((x) => `<div class="col"><div style="font-size:11px">${x.n || ''}</div><div class="stack" style="height:${Math.round((x.n / maxN) * 80)}px"><div class="s-ng" style="height:${x.n ? ((x.n - x.ok) / x.n) * 100 : 0}%"></div><div class="s-ok" style="height:${x.n ? (x.ok / x.n) * 100 : 0}%"></div></div><div>${parseYmd(x.d).getMonth() + 1}/${parseYmd(x.d).getDate()}</div></div>`).join('');
      const dist = [{ l: '未学習', c: st.news }];
      for (let lv = 0; lv <= 5; lv++) dist.push({ l: `Lv.${lv}`, c: ws.filter((w) => w.study > 0 && w.level === lv).length });
      const maxC = Math.max(1, ...dist.map((x) => x.c));
      body.innerHTML = `
        <div class="kv">
          <div class="tile"><div class="num">${rate}<small>%</small></div><div class="lbl">全体の正解率（${st.ok}/${tot}）</div></div>
          <div class="tile"><div class="num">${tRate === null ? '-' : tRate + '<small>%</small>'}</div><div class="lbl">今日の正解率（${todayH.length}回）</div></div>
          <div class="tile"><div class="num">${st.mastered}</div><div class="lbl">習得済み</div></div>
          <div class="tile"><div class="num">${st.total - st.mastered}</div><div class="lbl">まだ覚えていない</div></div>
          <div class="tile"><div class="num">${st.dueToday + st.overdue}</div><div class="lbl">復習予定（今日まで）</div></div>
          <div class="tile"><div class="num">${st.news}</div><div class="lbl">未学習</div></div>
        </div>
        <div class="card"><b>直近7日間の学習回数</b><div class="sub">ティール＝分かる ・ 黄＝分からない</div><div class="bars">${bars}</div></div>
        <div class="card"><b>習熟度の分布</b>${dist.map((x) => `<div class="hbar"><span>${x.l}</span><div class="track"><div class="fill" style="width:${(x.c / maxC) * 100}%"></div></div><span>${x.c}</span></div>`).join('')}</div>`;
    } else if (statusUI.tab === 'words') {
      const F = [['scheduled', '復習予定'], ['mastered', '習得済み'], ['notyet', 'まだ覚えていない'], ['new', '未学習']];
      let list;
      if (statusUI.f === 'scheduled') list = ws.filter((w) => w.study > 0 && w.next).sort((a, b) => a.next.localeCompare(b.next) || a.word.localeCompare(b.word));
      else if (statusUI.f === 'mastered') list = ws.filter((w) => w.study > 0 && w.level >= MASTER).sort((a, b) => a.word.localeCompare(b.word));
      else if (statusUI.f === 'notyet') list = ws.filter((w) => !(w.study > 0 && w.level >= MASTER)).sort((a, b) => a.word.localeCompare(b.word));
      else list = ws.filter((w) => w.study === 0).sort((a, b) => a.created - b.created);
      body.innerHTML = `<div class="chipbar">${F.map(([k, l]) => `<button type="button" class="chip-btn${statusUI.f === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
        <div class="sub">${list.length}語</div><div class="list" id="stList">${list.length ? list.slice(0, 200).map((w) => itemHtml(w, t, true)).join('') : '<div class="empty">該当する単語はありません</div>'}</div>
        ${list.length > 200 ? '<div class="sub center">先頭200語のみ表示しています</div>' : ''}`;
      bindThumbErrors(body);
    } else {
      const hs = [...S.history].sort((a, b) => b.ts - a.ts).slice(0, 300);
      if (!hs.length) { body.innerHTML = '<div class="empty">まだ学習履歴がありません</div>'; return; }
      let out = '', cur = '';
      hs.forEach((h) => {
        if (h.date !== cur) { cur = h.date; out += `<div class="hday">${esc(cur)}</div>`; }
        const d = new Date(h.ts);
        out += `<div class="hrow"><span class="t">${z2(d.getHours())}:${z2(d.getMinutes())}</span><span class="w">${esc(h.word)}</span><span class="r ${h.r ? 'ok-c' : 'ng-c'}">${h.r ? '○ 分かる' : '× 分からない'}</span></div>`;
      });
      body.innerHTML = `<div class="card">${out}</div>${S.history.length > 300 ? '<div class="sub center">直近300件を表示しています</div>' : ''}`;
    }
  }

  // ---------------------------------------------------------------- 設定
  function renderSettings() {
    const c = getCfg();
    if (document.activeElement !== $('#cfgUrl')) $('#cfgUrl').value = c.url || '';
    if (document.activeElement !== $('#cfgToken')) $('#cfgToken').value = c.token || '';
    const stateTxt = !isCloud() ? '未連携（この端末だけに保存中）'
      : syncState === 'error' ? `連携中（エラー：${lastError}）` : `連携中 ／ 未同期 ${pendCount()}件`;
    $('#cfgInfo').textContent = `状態：${stateTxt}`;
  }

  async function saveCfg() {
    let url = $('#cfgUrl').value.trim();
    const token = $('#cfgToken').value.trim();
    if (!url || !token) { toastErr('URLと合言葉（TOKEN）の両方を入力してください'); return; }
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { toastErr('URLは https://script.google.com/macros/s/…/exec の形式で入力してください'); return; }
    const wasCloud = isCloud();
    setCfg({ url, token });
    try {
      const r = await api({ action: 'ping' });
      toast(`接続できました（サーバー上の単語 ${r.words}語）`);
    } catch (e) {
      toastErr(e.message);
      renderSettings(); renderSync();
      return;
    }
    if (!wasCloud && Object.keys(S.words).length) {
      if (confirm(`この端末の単語 ${Object.keys(S.words).length}語と学習履歴をスプレッドシートに送信しますか？\n\n［OK］送信して統合する\n［キャンセル］送信せず、スプレッドシートの内容に置き換える`)) markAllPending();
      else { S.words = {}; S.history = []; S.pend = { w: {}, d: {}, h: {} }; }
    }
    S.cursor = { since: 0, hist: 0 };
    save();
    await sync(true);
    renderSettings();
  }
  function markAllPending() {
    Object.keys(S.words).forEach((id) => { S.pend.w[id] = true; });
    S.history.forEach((h) => { S.pend.h[h.id] = true; });
    save();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ app: 'vocab', version: 1, exportedAt: new Date().toISOString(), words: Object.values(S.words), history: S.history }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vocab-backup-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importJson(file) {
    try {
      const o = JSON.parse(await file.text());
      if (!o || !Array.isArray(o.words)) throw new Error('形式が正しくありません');
      if (!confirm(`${o.words.length}語を読み込みます。同じIDの単語は上書きされます。よろしいですか？`)) return;
      o.words.forEach((w) => {
        if (!w || !w.id || !w.word) return;
        const base = createWord(w.word, w.ja, w.img, w.created || Date.now());
        S.words[w.id] = { ...base, ...w, mtime: Date.now() };
        markPend(w.id);
      });
      const have = new Set(S.history.map((h) => h.id));
      (o.history || []).forEach((h) => { if (h && h.id && !have.has(h.id)) { S.history.push(h); S.pend.h[h.id] = true; } });
      S.history.sort((a, b) => a.ts - b.ts);
      save(); scheduleSync(500);
      refreshCurrentView(); renderSync();
      toast('読み込みました');
    } catch (e) { toastErr(`読み込みに失敗しました：${e.message}`); }
  }

  // ---------------------------------------------------------------- イベント
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    if (e.target.id === 'bnRetry') sync(true);
  });
  $('#btnSettings').addEventListener('click', () => go('settings'));
  $('#syncChip').addEventListener('click', () => { if (isCloud()) sync(true); else go('settings'); });
  $('#btnStart').addEventListener('click', () => go('setup'));
  $('#goWords').addEventListener('click', () => go('words'));
  $('#goStatus').addEventListener('click', () => go('status'));

  // 学習設定
  ['optJa', 'optRev', 'optNew'].forEach((id) => $('#' + id).addEventListener('input', updateSetupInfo));
  $('#newMinus').addEventListener('click', () => { $('#optNew').value = Math.max(0, (parseInt($('#optNew').value, 10) || 0) - 1); updateSetupInfo(); });
  $('#newPlus').addEventListener('click', () => { $('#optNew').value = Math.min(500, (parseInt($('#optNew').value, 10) || 0) + 1); updateSetupInfo(); });
  $('#newChips').addEventListener('click', (e) => { const b = e.target.closest('[data-n]'); if (b) { $('#optNew').value = b.dataset.n; updateSetupInfo(); } });
  $('#btnGo').addEventListener('click', startSession);

  // 学習
  $('#btnOk').addEventListener('click', () => answer(true));
  $('#btnNg').addEventListener('click', () => answer(false));
  $('#btnNext').addEventListener('click', nextCard);
  $('#stClose').addEventListener('click', () => { if (!sess || confirm('学習を終了しますか？（ここまでの結果は保存されています）')) quitSession(); });
  $('#dHome').addEventListener('click', () => go('home'));
  $('#dAgain').addEventListener('click', () => go('setup'));
  document.addEventListener('keydown', (e) => {
    if (view !== 'study' || !sess || $('dialog[open]')) return;
    if (!sess.answered) {
      if (e.key === 'ArrowRight') answer(true);
      else if (e.key === 'ArrowLeft') answer(false);
    } else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextCard(); }
  });

  // 単語管理
  $('#wAdd').addEventListener('click', () => openEdit(null));
  $('#wBulk').addEventListener('click', () => openDlg(dlgBulk));
  $('#wSearch').addEventListener('input', (e) => { wordsUI.q = e.target.value; renderWords(); });
  $('#wFilter').addEventListener('change', (e) => { wordsUI.f = e.target.value; renderWords(); });
  $('#wMore').addEventListener('click', () => { wordsUI.limit += 60; renderWords(true); });
  const onItemClick = (e) => { const it = e.target.closest('.item'); if (it) openEdit(it.dataset.id); };
  $('#wList').addEventListener('click', onItemClick);
  $('#stBody').addEventListener('click', (e) => {
    onItemClick(e);
    const f = e.target.closest('[data-f]');
    if (f) { statusUI.f = f.dataset.f; renderStatus(); }
  });
  $('#stTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { statusUI.tab = b.dataset.tab; renderStatus(); } });

  // 編集ダイアログ
  $('#dwCancel').addEventListener('click', () => closeDlg(dlgWord));
  $('#dwSave').addEventListener('click', saveWordDlg);
  $('#dwDelete').addEventListener('click', () => deleteWord(edit.id));
  $('#dwReset').addEventListener('click', () => resetWord(edit.id));
  $('#dwClear').addEventListener('click', () => { edit.img = ''; $('#dwUrl').value = ''; $('#dwFile').value = ''; dwPreview(); });
  $('#dwFile').addEventListener('change', (e) => setImageFromFile(e.target.files[0]));
  $('#dwUrl').addEventListener('input', (e) => {
    try { edit.img = normalizeUrl(e.target.value); dwMsg(''); } catch (err) { dwMsg(err.message); edit.img = ''; }
    dwPreview();
  });
  $('#dwWord').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dwJa').focus(); } });
  $('#dwJa').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveWordDlg(); } });
  dlgWord.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); setImageFromFile(f); }
  });
  $('#bkCancel').addEventListener('click', () => closeDlg(dlgBulk));
  $('#bkAdd').addEventListener('click', bulkAdd);

  // 設定
  $('#cfgSave').addEventListener('click', saveCfg);
  $('#cfgTest').addEventListener('click', async () => {
    const url = $('#cfgUrl').value.trim(), token = $('#cfgToken').value.trim();
    if (!url || !token) { toastErr('URLと合言葉を入力してください'); return; }
    const prev = getCfg();
    setCfg({ url, token });
    try { const r = await api({ action: 'ping' }); toast(`接続OK（サーバー上の単語 ${r.words}語）`); } catch (e) { toastErr(e.message); }
    setCfg(prev);
  });
  $('#cfgSync').addEventListener('click', () => { if (!isCloud()) toastErr('先に連携を設定してください'); else sync(true); });
  $('#cfgUploadAll').addEventListener('click', () => {
    if (!isCloud()) { toastErr('先に連携を設定してください'); return; }
    if (!confirm('この端末の単語と履歴をすべてスプレッドシートに送信します。サーバー側の同じ単語は上書きされます。よろしいですか？')) return;
    markAllPending(); sync(true);
  });
  $('#cfgRefetch').addEventListener('click', () => {
    if (!isCloud()) { toastErr('先に連携を設定してください'); return; }
    S.cursor = { since: 0, hist: 0 }; save(); sync(true);
  });
  $('#cfgDisconnect').addEventListener('click', () => {
    if (!isCloud()) return;
    if (!confirm('連携を解除します。この端末の単語と学習記録は残り、以後この端末だけに保存されます。よろしいですか？')) return;
    localStorage.removeItem(LS_CFG);
    S.pend = { w: {}, d: {}, h: {} }; S.cursor = { since: 0, hist: 0 };
    save(); renderSettings(); renderSync(); toast('連携を解除しました');
  });
  $('#bkExport').addEventListener('click', exportJson);
  $('#bkImport').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });

  // 同期のきっかけ
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isCloud() && view !== 'study') sync(false); });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('error', () => toastErr('予期しないエラーが発生しました。ページを再読み込みしてください。'));
  window.addEventListener('unhandledrejection', () => toastErr('予期しないエラーが発生しました。'));

  // ---------------------------------------------------------------- 起動
  go('home');
  if (isCloud()) sync(false);

  // テスト用に純粋関数を公開（画面操作には影響しません）
  window.__vocab = { reviewWord, priority, buildQueue, addDays, diffDays, getState: () => S };
})();
