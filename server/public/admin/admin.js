/* ============================================================
 * Proje X — Yönetim Paneli
 * Saf JavaScript, framework yok.
 *
 * GÜVENLİK NOTU (XSS):
 * Kullanıcıdan gelen hiçbir içerik (isimler, notlar, mesajlar,
 * sebepler...) ASLA innerHTML ile DOM'a yazılmaz. Tüm dinamik
 * içerik textContent / createElement ile eklenir.
 * ============================================================ */
(() => {
  'use strict';

  /* ==================== Sabitler ve durum ==================== */

  const TOKEN_KEY = 'projex_admin_token'; // sessionStorage anahtarı
  const DASHBOARD_REFRESH_MS = 10000;     // Genel Bakış yenileme aralığı
  const SEARCH_DEBOUNCE_MS = 300;         // kullanıcı arama debounce süresi

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY), // Bearer token
    activeTab: 'dashboard',                   // aktif sekme
    reportsStatus: 'pending',                 // rapor alt sekmesi: pending | reviewed
    killswitch: false,                        // acil durdurma durumu
    dashboardTimer: null,                     // otomatik yenileme zamanlayıcısı
    searchTimer: null,                        // arama debounce zamanlayıcısı
    modalObjectUrl: null,                     // kanıt görseli blob URL'i (temizlik için)
  };

  /* ==================== Etiket sözlükleri ==================== */

  // Rapor kategorileri (siddet ve resit_olmayan kırmızı vurgulanır)
  const CATEGORY_LABELS = {
    ciplaklik: 'Çıplaklık',
    taciz: 'Taciz',
    nefret: 'Nefret Söylemi',
    siddet: 'Şiddet',
    resit_olmayan: 'Reşit Olmayan Şüphesi',
    spam: 'Spam',
    diger: 'Diğer',
  };
  const CATEGORY_DANGER = new Set(['siddet', 'resit_olmayan']);

  // Rapor çözüm aksiyonları
  const ACTION_LABELS = {
    dismissed: 'Reddedildi',
    warned: 'Uyarıldı',
    suspended: 'Askıya Alındı',
    banned: 'Banlandı',
  };

  // Kullanıcı durumları
  const STATUS_LABELS = {
    active: 'Aktif',
    suspended: 'Askıda',
    banned: 'Banlı',
  };

  /* ==================== Kısa DOM yardımcıları ==================== */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /**
   * Güvenli element oluşturucu: metin daima textContent ile yazılır,
   * bu yüzden HTML olarak yorumlanamaz (XSS koruması).
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Bir düğümün tüm çocuklarını temizler. */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ==================== Biçimleyiciler ==================== */

  /** Milisaniye zaman damgasını tr-TR yerel biçimiyle yazar. */
  function fmtDate(ms) {
    if (ms === null || ms === undefined) return '—';
    return new Date(ms).toLocaleString('tr-TR');
  }

  /** Sayıyı tr-TR binlik ayraçlarıyla yazar. */
  function fmtNum(n) {
    return typeof n === 'number' && !Number.isNaN(n) ? n.toLocaleString('tr-TR') : '—';
  }

  /** Saniyeyi "X dk Y sn" biçimine çevirir. */
  function fmtDuration(sec) {
    if (typeof sec !== 'number' || Number.isNaN(sec)) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m} dk ${s} sn`;
  }

  /** 0-1 arası oranı yüzdeye çevirir (0.42 → "%42", 0.417 → "%41,7"). */
  function fmtPercent(rate) {
    if (typeof rate !== 'number' || Number.isNaN(rate)) return '—';
    const pct = Math.round(rate * 1000) / 10; // tek ondalık hane
    return '%' + pct.toLocaleString('tr-TR');
  }

  /* ==================== Toast bildirimleri ==================== */

  /**
   * Sağ altta kendiliğinden kaybolan bildirim gösterir.
   * type: 'error' (varsayılan) | 'success'
   */
  function toast(message, type = 'error') {
    const box = el('div', 'toast' + (type === 'success' ? ' toast-success' : ''), message);
    $('#toast-container').appendChild(box);
    // Giriş animasyonu için bir frame bekle
    requestAnimationFrame(() => box.classList.add('show'));
    setTimeout(() => {
      box.classList.remove('show');
      setTimeout(() => box.remove(), 300); // geçiş bitince DOM'dan kaldır
    }, 4000);
  }

  /* ==================== API katmanı ==================== */

  /**
   * Yetkili API isteği. Authorization: Bearer <token> başlığını ekler.
   * - 401 dönerse oturumu kapatıp giriş ekranına düşer.
   * - Diğer hatalarda toast gösterir ve hata fırlatır.
   * - options.raw = true ise JSON yerine ham Response döner (blob için).
   */
  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

    let body = options.body;
    if (body !== undefined && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, { method: options.method || 'GET', headers, body });
    } catch (err) {
      toast('Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.');
      throw err;
    }

    if (res.status === 401) {
      // Token geçersiz/süresi dolmuş — girişe geri dön
      logout(true);
      throw new Error('Yetkisiz (401)');
    }
    if (!res.ok) {
      toast(`İstek başarısız oldu (HTTP ${res.status})`);
      throw new Error('HTTP ' + res.status);
    }

    return options.raw ? res : res.json();
  }

  /* ==================== Giriş / çıkış ==================== */

  async function handleLogin(e) {
    e.preventDefault();
    const errBox = $('#login-error');
    errBox.classList.add('hidden');

    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const btn = $('#login-submit');
    btn.disabled = true;
    btn.textContent = 'Giriş yapılıyor…';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (res.status === 401) {
        errBox.textContent = 'Kullanıcı adı veya şifre hatalı';
        errBox.classList.remove('hidden');
        return;
      }
      if (!res.ok) {
        errBox.textContent = `Giriş başarısız (HTTP ${res.status})`;
        errBox.classList.remove('hidden');
        return;
      }

      const data = await res.json();
      if (!data.ok || !data.token) {
        errBox.textContent = 'Beklenmeyen sunucu yanıtı';
        errBox.classList.remove('hidden');
        return;
      }

      // Başarılı giriş: token'ı sakla ve paneli aç
      state.token = data.token;
      sessionStorage.setItem(TOKEN_KEY, state.token);
      $('#login-password').value = '';
      showPanel();
    } catch (err) {
      errBox.textContent = 'Sunucuya ulaşılamadı';
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Giriş Yap';
    }
  }

  /** Oturumu kapatır. expired=true ise "oturum doldu" bildirimi gösterir. */
  function logout(expired = false) {
    state.token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    closeModal();
    showLogin();
    if (expired) toast('Oturum sona erdi, lütfen tekrar giriş yapın.');
  }

  function showLogin() {
    stopDashboardTimer();
    $('#panel').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    const input = $('#login-username');
    if (input) input.focus();
  }

  function showPanel() {
    $('#login-screen').classList.add('hidden');
    $('#panel').classList.remove('hidden');
    switchTab('dashboard');
  }

  /* ==================== Sekme yönetimi ==================== */

  const TAB_LOADERS = {
    dashboard: loadDashboard,
    reports: loadReports,
    users: loadUsers,
    bans: loadBans,
  };

  function switchTab(tab) {
    state.activeTab = tab;

    // Menü ve içerik görünürlüğünü güncelle
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + tab));

    // Otomatik yenileme yalnızca Genel Bakış sekmesinde çalışır
    stopDashboardTimer();
    if (tab === 'dashboard') startDashboardTimer();

    TAB_LOADERS[tab]().catch(() => { /* hata toast'ı api() içinde gösterildi */ });
  }

  function startDashboardTimer() {
    stopDashboardTimer();
    state.dashboardTimer = setInterval(() => {
      loadDashboard().catch(() => {});
    }, DASHBOARD_REFRESH_MS);
  }

  function stopDashboardTimer() {
    if (state.dashboardTimer) {
      clearInterval(state.dashboardTimer);
      state.dashboardTimer = null;
    }
  }

  /* ==================== A) GENEL BAKIŞ ==================== */

  // Metrik kartı tanımları (sıra, etiket, biçimleyici, özel vurgular)
  const METRICS = [
    { key: 'online',           label: 'Çevrimiçi',               fmt: fmtNum },
    { key: 'inQueue',          label: 'Kuyrukta',                fmt: fmtNum },
    { key: 'activeMatches',    label: 'Aktif Görüşme',           fmt: fmtNum },
    { key: 'totalUsers',       label: 'Toplam Kullanıcı',        fmt: fmtNum },
    { key: 'newUsers24h',      label: 'Yeni Kullanıcı (24s)',    fmt: fmtNum },
    { key: 'matches24h',       label: 'Eşleşme (24s)',           fmt: fmtNum },
    { key: 'avgDurationSec',   label: 'Ort. Görüşme Süresi',     fmt: fmtDuration },
    { key: 'skipRate',         label: 'Geçme Oranı',             fmt: fmtPercent },
    { key: 'mutualFriendRate', label: 'Karşılıklı Ekleme Oranı', fmt: fmtPercent, northStar: true },
    { key: 'pendingReports',   label: 'Bekleyen Rapor',          fmt: fmtNum, dangerIfPositive: true },
    { key: 'messages24h',      label: 'Mesaj (24s)',             fmt: fmtNum },
    { key: 'flagged24h',       label: 'Filtrelenen Mesaj (24s)', fmt: fmtNum },
    { key: 'suspended',        label: 'Askıda',                  fmt: fmtNum },
    { key: 'banned',           label: 'Banlı',                   fmt: fmtNum },
  ];

  async function loadDashboard() {
    const data = await api('/api/admin/dashboard');

    // Acil durdurma durumunu panel geneline yansıt (anahtar + uyarı bandı)
    setKillswitchUI(!!data.killswitch);

    const grid = $('#dashboard-grid');
    clear(grid);

    for (const m of METRICS) {
      const card = el('div', 'metric-card');
      if (m.northStar) card.classList.add('north-star');
      if (m.dangerIfPositive && data[m.key] > 0) card.classList.add('danger');

      const head = el('div', 'metric-head');
      head.appendChild(el('span', 'metric-label', m.label));
      if (m.northStar) head.appendChild(el('span', 'badge badge-north', '★ Kuzey Yıldızı'));
      card.appendChild(head);

      card.appendChild(el('div', 'metric-value', m.fmt(data[m.key])));
      grid.appendChild(card);
    }
  }

  /* ==================== Acil Durdurma (killswitch) ==================== */

  /** Anahtarın ve uyarı bandının görünümünü günceller. */
  function setKillswitchUI(on) {
    state.killswitch = on;
    $('#killswitch-toggle').checked = on;
    $('#killswitch-banner').classList.toggle('hidden', !on);
  }

  async function handleKillswitchChange(e) {
    const wanted = e.target.checked;
    const msg = wanted
      ? 'Tüm eşleşmeler durdurulacak, emin misiniz?'
      : 'Acil durdurma kapatılacak ve eşleşmeler yeniden başlayacak, emin misiniz?';

    if (!confirm(msg)) {
      e.target.checked = state.killswitch; // vazgeçildi — anahtarı geri al
      return;
    }

    try {
      await api('/api/admin/killswitch', { method: 'POST', body: { on: wanted } });
      setKillswitchUI(wanted);
      toast(wanted ? 'Acil durdurma AÇILDI' : 'Acil durdurma kapatıldı', wanted ? 'error' : 'success');
    } catch (err) {
      e.target.checked = state.killswitch; // istek başarısız — eski duruma dön
    }
  }

  /* ==================== B) RAPOR KUYRUĞU ==================== */

  async function loadReports() {
    const listBox = $('#reports-list');
    clear(listBox);
    listBox.appendChild(el('p', 'muted empty', 'Yükleniyor…'));

    let data;
    try {
      data = await api('/api/admin/reports?status=' + encodeURIComponent(state.reportsStatus));
    } catch (err) {
      // İstek başarısızsa (ağ/500) 'Yükleniyor…' göstergesi sonsuza dek takılı
      // kalmasın; hata satırı + yeniden dene butonu göster.
      clear(listBox);
      const errBox = el('p', 'muted empty', 'Raporlar yüklenemedi. ');
      const retry = el('button', 'btn btn-small', 'Tekrar dene');
      retry.addEventListener('click', loadReports);
      errBox.appendChild(retry);
      listBox.appendChild(errBox);
      return;
    }

    clear(listBox);
    const reports = data.reports || [];
    if (reports.length === 0) {
      listBox.appendChild(el('p', 'muted empty',
        state.reportsStatus === 'pending' ? 'Bekleyen rapor yok.' : 'İncelenmiş rapor yok.'));
      return;
    }
    reports.forEach((r) => listBox.appendChild(buildReportCard(r)));
  }

  /** Tek bir rapor kartını (tamamen güvenli DOM API'leriyle) kurar. */
  function buildReportCard(r) {
    const reporter = r.reporter || {};
    const reported = r.reported || {};
    const card = el('article', 'report-card');

    // --- Üst satır: kategori rozeti + tarih ---
    const top = el('div', 'report-top');
    const badge = el('span', 'badge badge-cat', CATEGORY_LABELS[r.category] || r.category || 'Bilinmiyor');
    if (CATEGORY_DANGER.has(r.category)) badge.classList.add('badge-danger');
    top.appendChild(badge);
    top.appendChild(el('span', 'report-date', fmtDate(r.createdAt)));
    card.appendChild(top);

    // --- Taraflar: raporlayan → raporlanan ---
    const parties = el('div', 'report-parties');

    const repSpan = el('span', 'party');
    repSpan.appendChild(el('strong', null, reporter.name || 'Bilinmiyor'));
    repSpan.appendChild(el('span', 'muted', ` (#${reporter.id ?? '?'})`));
    parties.appendChild(repSpan);

    parties.appendChild(el('span', 'arrow', '→'));

    const tgtSpan = el('span', 'party');
    tgtSpan.appendChild(el('strong', null, reported.name || 'Bilinmiyor'));
    tgtSpan.appendChild(el('span', 'muted', ` (#${reported.id ?? '?'} · güven: ${reported.trust ?? '—'})`));
    if (reported.status && reported.status !== 'active') {
      tgtSpan.appendChild(document.createTextNode(' '));
      const st = el('span', 'badge badge-mini', STATUS_LABELS[reported.status] || reported.status);
      st.classList.add(reported.status === 'banned' ? 'badge-danger' : 'badge-warn');
      tgtSpan.appendChild(st);
    }
    parties.appendChild(tgtSpan);
    card.appendChild(parties);

    // --- Not (kullanıcı içeriği — textContent ile) ---
    if (r.note) {
      const note = el('p', 'report-note');
      note.appendChild(el('span', 'muted', 'Not: '));
      note.appendChild(document.createTextNode(r.note));
      card.appendChild(note);
    }

    // --- Sohbet dökümü (açılır bölüm) ---
    if (Array.isArray(r.chatExcerpt) && r.chatExcerpt.length > 0) {
      const details = el('details', 'chat-excerpt');
      details.appendChild(el('summary', null, `Sohbet Dökümü (${r.chatExcerpt.length} mesaj)`));

      const list = el('div', 'chat-messages');
      for (const msg of r.chatExcerpt) {
        const row = el('div', 'chat-msg');
        // Raporlanan kullanıcının mesajlarını görsel olarak ayırt et
        if (msg.sender_id === reported.id) row.classList.add('from-reported');

        const meta = el('div', 'chat-meta');
        meta.appendChild(el('span', 'chat-sender', '#' + (msg.sender_id ?? '?')));
        meta.appendChild(el('span', 'chat-time', fmtDate(msg.created_at)));
        row.appendChild(meta);

        row.appendChild(el('div', 'chat-body', msg.body ?? '')); // mesaj gövdesi — textContent
        list.appendChild(row);
      }
      details.appendChild(list);
      card.appendChild(details);
    }

    // --- Alt satır: kanıt butonu + aksiyonlar / sonuç rozeti ---
    const foot = el('div', 'report-actions');

    if (r.evidenceUrl) {
      const evBtn = el('button', 'btn btn-ghost btn-sm', 'Kanıtı Göster');
      evBtn.type = 'button';
      evBtn.addEventListener('click', () => showEvidence(r.evidenceUrl));
      foot.appendChild(evBtn);
    }

    if (r.status === 'pending') {
      const actions = [
        { action: 'dismissed', label: 'Reddet',    cls: 'btn-ghost' },
        { action: 'warned',    label: 'Uyar',      cls: 'btn-warn' },
        { action: 'suspended', label: 'Askıya Al', cls: 'btn-warn' },
        { action: 'banned',    label: 'Banla',     cls: 'btn-danger' },
      ];
      for (const a of actions) {
        const btn = el('button', 'btn btn-sm ' + a.cls, a.label);
        btn.type = 'button';
        btn.addEventListener('click', () => resolveReport(r, a.action, card));
        foot.appendChild(btn);
      }
    } else {
      // İncelenmiş rapor: alınan aksiyonu göster
      foot.appendChild(el('span', 'badge badge-mini',
        'Sonuç: ' + (ACTION_LABELS[r.actionTaken] || r.actionTaken || '—')));
    }

    card.appendChild(foot);
    return card;
  }

  /** Bekleyen raporu çözümler (dismiss/warn/suspend/ban). */
  async function resolveReport(report, action, card) {
    if (action === 'banned') {
      const name = (report.reported && report.reported.name) || 'Kullanıcı';
      if (!confirm(`"${name}" banlanacak, emin misiniz?`)) return;
    }

    // Çift tıklamayı önlemek için kart butonlarını kilitle
    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));

    try {
      await api(`/api/admin/reports/${encodeURIComponent(report.id)}/resolve`, {
        method: 'POST',
        body: { action },
      });
      toast('Rapor işlendi: ' + (ACTION_LABELS[action] || action), 'success');
      await loadReports(); // listeyi yenile
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false)); // hata — butonları geri aç
    }
  }

  /* ---------- Kanıt modalı ---------- */

  /**
   * Kanıt görselini gösterir. Görsel URL'i Authorization başlığı
   * gerektirdiğinden img.src'ye doğrudan verilemez; fetch ile blob
   * olarak çekilip geçici bir object URL üzerinden gösterilir.
   */
  async function showEvidence(url) {
    try {
      const res = await api(url, { raw: true });
      const blob = await res.blob();
      openModal(blob);
    } catch (err) {
      /* hata toast'ı api() içinde gösterildi */
    }
  }

  function openModal(blob) {
    closeModal(); // önceki object URL varsa temizle
    state.modalObjectUrl = URL.createObjectURL(blob);
    $('#modal-img').src = state.modalObjectUrl;
    $('#modal-overlay').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    $('#modal-img').removeAttribute('src');
    if (state.modalObjectUrl) {
      URL.revokeObjectURL(state.modalObjectUrl); // bellek sızıntısını önle
      state.modalObjectUrl = null;
    }
  }

  /* ==================== C) KULLANICILAR ==================== */

  async function loadUsers() {
    const q = $('#user-search').value.trim();
    const data = await api('/api/admin/users?q=' + encodeURIComponent(q));

    const tbody = $('#users-tbody');
    clear(tbody);

    const users = data.users || [];
    if (users.length === 0) {
      const tr = el('tr', 'empty-row');
      const td = el('td', null, 'Kullanıcı bulunamadı.');
      td.colSpan = 8;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    users.forEach((u) => tbody.appendChild(buildUserRow(u)));
  }

  /** Tek bir kullanıcı tablosu satırını kurar. */
  function buildUserRow(u) {
    const tr = document.createElement('tr');

    // ID + İsim (kullanıcı içeriği — textContent)
    tr.appendChild(el('td', 'muted', '#' + u.id));
    tr.appendChild(el('td', 'strong-cell', u.displayName || '—'));

    // Durum rozeti (+ askı bitişi varsa altında göster)
    const tdStatus = el('td');
    const stBadge = el('span', 'badge', STATUS_LABELS[u.status] || u.status || '—');
    stBadge.classList.add(
      u.status === 'active' ? 'badge-ok' : u.status === 'suspended' ? 'badge-warn' : 'badge-danger'
    );
    tdStatus.appendChild(stBadge);
    if (u.status === 'suspended' && u.suspendedUntil) {
      tdStatus.appendChild(el('div', 'muted small', fmtDate(u.suspendedUntil) + " tarihine kadar"));
    }
    tr.appendChild(tdStatus);

    // Çevrimiçi göstergesi
    const tdOnline = el('td');
    if (u.online) {
      const dot = el('span', 'online-dot');
      dot.title = 'Çevrimiçi';
      tdOnline.appendChild(dot);
    } else {
      tdOnline.appendChild(el('span', 'muted', '—'));
    }
    tr.appendChild(tdOnline);

    // Güven puanı: ≥70 yeşil, 40-69 sarı, <40 kırmızı
    const tdTrust = el('td');
    const trustSpan = el('span', 'trust', typeof u.trustScore === 'number' ? u.trustScore : '—');
    if (typeof u.trustScore === 'number') {
      trustSpan.classList.add(
        u.trustScore >= 70 ? 'trust-high' : u.trustScore >= 40 ? 'trust-mid' : 'trust-low'
      );
    }
    tdTrust.appendChild(trustSpan);
    tr.appendChild(tdTrust);

    // Rapor sayısı + kayıt tarihi
    tr.appendChild(el('td', null, fmtNum(u.reportCount)));
    tr.appendChild(el('td', 'muted', fmtDate(u.createdAt)));

    // Duruma göre uygun aksiyonlar
    const tdActions = el('td', 'row-actions');
    if (u.status === 'banned') {
      addRowAction(tdActions, 'Ban Kaldır', 'btn-ghost', () => unbanUser(u));
    } else {
      if (u.status === 'suspended') {
        addRowAction(tdActions, 'Askıyı Kaldır', 'btn-ghost', () => unsuspendUser(u));
      }
      addRowAction(tdActions, 'Banla', 'btn-danger', () => banUser(u));
    }
    tr.appendChild(tdActions);

    return tr;
  }

  function addRowAction(td, label, cls, handler) {
    const btn = el('button', 'btn btn-sm ' + cls, label);
    btn.type = 'button';
    btn.addEventListener('click', handler);
    td.appendChild(btn);
  }

  /** Kullanıcı banlama: gün sayısı prompt ile sorulur (boş = kalıcı). */
  async function banUser(u) {
    const daysRaw = prompt(
      `"${u.displayName}" (#${u.id}) kaç gün banlansın?\nBoş bırakırsanız ban KALICI olur.`, ''
    );
    if (daysRaw === null) return; // vazgeçildi

    let days = null; // null = kalıcı ban
    const trimmed = daysRaw.trim();
    if (trimmed !== '') {
      days = parseInt(trimmed, 10);
      if (Number.isNaN(days) || days <= 0) {
        toast('Geçersiz gün sayısı');
        return;
      }
    }

    const reason = prompt('Ban sebebi:', 'Kural ihlali');
    if (reason === null) return; // vazgeçildi

    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}/ban`, {
        method: 'POST',
        body: { reason: reason.trim() || 'Kural ihlali', days },
      });
      toast(days ? `Kullanıcı ${days} gün banlandı` : 'Kullanıcı kalıcı olarak banlandı', 'success');
      loadUsers().catch(() => {});
    } catch (err) { /* toast api() içinde gösterildi */ }
  }

  async function unbanUser(u) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}/unban`, { method: 'POST' });
      toast('Ban kaldırıldı', 'success');
      loadUsers().catch(() => {});
    } catch (err) { /* toast api() içinde gösterildi */ }
  }

  async function unsuspendUser(u) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}/unsuspend`, { method: 'POST' });
      toast('Askı kaldırıldı', 'success');
      loadUsers().catch(() => {});
    } catch (err) { /* toast api() içinde gösterildi */ }
  }

  /* ==================== D) BANLAR ==================== */

  async function loadBans() {
    const data = await api('/api/admin/bans');

    const tbody = $('#bans-tbody');
    clear(tbody);

    const bans = data.bans || [];
    if (bans.length === 0) {
      const tr = el('tr', 'empty-row');
      const td = el('td', null, 'Ban kaydı yok.');
      td.colSpan = 4;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const b of bans) {
      const tr = document.createElement('tr');

      // Kullanıcı (isim kullanıcı içeriği — textContent)
      const tdUser = el('td');
      tdUser.appendChild(el('strong', null, b.name || '—'));
      tdUser.appendChild(el('span', 'muted', ` (#${b.userId ?? '?'})`));
      tr.appendChild(tdUser);

      // Sebep (kullanıcı içeriği — textContent)
      tr.appendChild(el('td', null, b.reason || '—'));

      // Bitiş: null → kalıcı ban
      tr.appendChild(
        b.expiresAt
          ? el('td', null, fmtDate(b.expiresAt))
          : el('td', 'permanent', 'Kalıcı')
      );

      tr.appendChild(el('td', 'muted', fmtDate(b.createdAt)));
      tbody.appendChild(tr);
    }
  }

  /* ==================== Başlatma ve olay bağlama ==================== */

  function init() {
    // Giriş formu
    $('#login-form').addEventListener('submit', handleLogin);

    // Sol menü sekmeleri
    $$('.nav-item').forEach((btn) =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    );

    // Çıkış
    $('#logout-btn').addEventListener('click', () => logout(false));

    // Acil durdurma anahtarı
    $('#killswitch-toggle').addEventListener('change', handleKillswitchChange);

    // Rapor alt sekmeleri (Bekleyen / İncelenen)
    $$('.subtab').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.reportsStatus = btn.dataset.status;
        $$('.subtab').forEach((b) => b.classList.toggle('active', b === btn));
        loadReports().catch(() => {});
      })
    );

    // Kullanıcı araması — 300 ms debounce
    $('#user-search').addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => loadUsers().catch(() => {}), SEARCH_DEBOUNCE_MS);
    });

    // Modal kapatma: X butonu, arka plana tıklama, Escape tuşu
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Tarayıcı sekmesi arka plandayken gereksiz istek atma
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopDashboardTimer();
      } else if (state.token && state.activeTab === 'dashboard') {
        loadDashboard().catch(() => {});
        startDashboardTimer();
      }
    });

    // Mevcut token varsa doğrudan paneli aç (geçersizse ilk 401'de girişe düşer)
    if (state.token) showPanel();
    else showLogin();
  }

  init();
})();
