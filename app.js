(function () {
  var data = null;
  var view = document.getElementById('view');
  var audio = document.getElementById('audio');
  var current = null; // lesson currently loaded in player
  var RATES = [1, 1.25, 1.5, 1.75, 2];
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('ll:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('ll:' + k, JSON.stringify(v)); } catch (e) {} }
  };

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmt(t) { t = Math.max(0, Math.floor(t || 0)); var m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function mins(sec) { return sec ? Math.max(1, Math.round(sec / 60)) + ' min' : ''; }
  function ago(iso) {
    if (!iso) return '';
    var d = new Date(iso), days = Math.floor((Date.now() - d) / 86400000);
    if (days <= 0) return 'Today'; if (days === 1) return 'Yesterday'; if (days < 7) return days + ' days ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function feedUrl() { return ((data && data.base_url) || location.href.replace(/[#?].*$/, '').replace(/index\.html$/, '').replace(/\/$/, '')) + '/feed.xml'; }
  function status(slug) { return store.get('status:' + slug, 'new'); }

  function setTab(name) {
    document.querySelectorAll('#tabs .tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.getElementById('tabs').style.display = name ? 'flex' : 'none';
  }

  function sourceLabel(m) {
    var t = (m.source_type || '').toLowerCase();
    return { tweet: 'Tweet', x: 'Tweet', blog: 'Blog post', paper: 'Paper', video: 'Video', topic: 'Topic', thread: 'Thread' }[t] || (m.source_type || '');
  }

  function renderLibrary() {
    setTab('library');
    var ls = data.lessons || [];
    if (!ls.length) {
      view.innerHTML = '<div class="lesson-card"><div class="font-medium">No lessons yet</div>' +
        '<p class="mt-1 text-sm muted">Send a link to your Learning Coach agent and your first lesson will show up here.</p></div>';
      return;
    }
    view.innerHTML = ls.map(function (m) {
      var st = status(m.slug);
      var chips = '<span class="chip ' + (st === 'done' ? 'done' : st === 'new' ? 'new' : '') + '">' +
        (st === 'done' ? 'Listened' : st === 'new' ? 'New' : 'In progress') + '</span>';
      if (sourceLabel(m)) chips += '<span class="chip">' + esc(sourceLabel(m)) + '</span>';
      (m.topics || []).slice(0, 3).forEach(function (t) { chips += '<span class="chip">' + esc(t) + '</span>'; });
      return '<a class="lesson-card" href="#/' + encodeURIComponent(m.slug) + '">' +
        '<div class="text-xs muted">' + esc(ago(m.created_at)) + (m.duration_secs ? ' · ' + mins(m.duration_secs) : '') + '</div>' +
        '<div class="mt-1 text-[15px] font-semibold leading-snug">' + esc(m.title) + '</div>' +
        (m.summary ? '<p class="mt-1 text-sm muted line-clamp-2">' + esc(m.summary) + '</p>' : '') +
        '<div class="mt-2">' + chips + '</div></a>';
    }).join('');
  }

  function renderNext() {
    setTab('next');
    var p = data.progress || {};
    var sugg = p.suggested_next || [];
    var concepts = p.concepts || [];
    var html = '<h2 class="text-sm font-semibold muted uppercase tracking-wide">Suggested next</h2>';
    html += sugg.length ? sugg.map(function (s) {
      return '<div class="lesson-card"><div class="font-semibold">' + esc(s.topic) + '</div>' +
        (s.why ? '<p class="mt-1 text-sm muted">' + esc(s.why) + '</p>' : '') +
        (s.source_url ? '<a class="mt-1 block text-xs underline muted" href="' + esc(s.source_url) + '" target="_blank" rel="noopener">Starting point</a>' : '') + '</div>';
    }).join('') : '<p class="text-sm muted mb-4">Suggestions show up after your first few lessons.</p>';
    html += '<h2 class="mt-6 text-sm font-semibold muted uppercase tracking-wide">What you\u2019ve covered</h2>';
    html += concepts.length ? '<div class="mt-2">' + concepts.map(function (c) {
      var name = typeof c === 'string' ? c : c.name;
      var lvl = typeof c === 'string' ? '' : (c.level || '');
      return '<span class="chip">' + esc(name) + (lvl ? ' · ' + esc(lvl) : '') + '</span>';
    }).join('') + '</div>' : '<p class="text-sm muted">Nothing yet.</p>';
    view.innerHTML = html;
  }

  function renderLesson(slug) {
    setTab(null);
    var m = (data.lessons || []).find(function (x) { return x.slug === slug; });
    if (!m) { view.innerHTML = '<p class="muted">Lesson not found.</p>'; return; }
    var st = status(slug);
    var head = '<a href="#/" class="text-sm muted no-underline">\u2190 Library</a>' +
      '<div class="mt-3 text-xs muted">' + esc(ago(m.created_at)) + (m.duration_secs ? ' · ' + mins(m.duration_secs) + ' listen' : '') +
      (sourceLabel(m) ? ' · from a ' + esc(sourceLabel(m).toLowerCase()) : '') + '</div>' +
      '<div class="mt-3 flex flex-wrap gap-2">' +
      (m.audio ? '<button id="play-lesson" class="pill">\u25B6 ' + (current && current.slug === slug && !audio.paused ? 'Playing' : 'Play lesson') + '</button>' : '') +
      '<button id="mark-done" class="pill">' + (st === 'done' ? '\u2713 Listened' : 'Mark as listened') + '</button>' +
      (m.source_url ? '<a class="pill no-underline" href="' + esc(m.source_url) + '" target="_blank" rel="noopener">Original</a>' : '') +
      '</div>';
    view.innerHTML = head + '<article id="article" class="article mt-4"><div class="skeleton h-40"></div></article><section id="extras"></section>';

    var pb = document.getElementById('play-lesson');
    if (pb) pb.onclick = function () { play(m); pb.textContent = '\u25B6 Playing'; };
    document.getElementById('mark-done').onclick = function (e) {
      var now = status(slug) === 'done' ? 'started' : 'done';
      store.set('status:' + slug, now);
      e.target.textContent = now === 'done' ? '\u2713 Listened' : 'Mark as listened';
    };

    var extras = '';
    if ((m.quiz || []).length) {
      extras += '<h2 class="mt-8 text-lg font-semibold">Check yourself</h2>' + m.quiz.map(function (q, i) {
        return '<div class="quiz-q"><div class="font-medium">' + (i + 1) + '. ' + esc(q.q || q.question) + '</div>' +
          '<button class="mt-2 text-xs underline muted" data-reveal="' + i + '">Show answer</button>' +
          '<div class="quiz-a hidden" id="qa-' + i + '">' + esc(q.a || q.answer) + '</div></div>';
      }).join('');
    }
    if ((m.related || []).length) {
      extras += '<h2 class="mt-8 text-lg font-semibold">Go deeper</h2><ul class="mt-2 space-y-2">' + m.related.map(function (r) {
        var t = typeof r === 'string' ? r : r.title;
        var u = typeof r === 'string' ? '' : r.url;
        return '<li class="text-sm">' + (u ? '<a class="underline" target="_blank" rel="noopener" href="' + esc(u) + '">' + esc(t) + '</a>' : esc(t)) +
          (r.why ? '<div class="muted text-xs">' + esc(r.why) + '</div>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    document.getElementById('extras').innerHTML = extras;
    document.querySelectorAll('[data-reveal]').forEach(function (b) {
      b.onclick = function () { document.getElementById('qa-' + b.dataset.reveal).classList.remove('hidden'); b.remove(); };
    });

    if (m.html) {
      fetch(m.html).then(function (r) { return r.text(); }).then(function (h) {
        var a = document.getElementById('article');
        if (!a) return;
        a.innerHTML = h;
        a.querySelectorAll('a').forEach(function (x) { x.target = '_blank'; x.rel = 'noopener'; });
      });
    } else {
      document.getElementById('article').innerHTML = '';
    }
    window.scrollTo(0, 0);
  }

  // ---- Player ----
  var player = document.getElementById('player');
  var toggle = document.getElementById('p-toggle');
  var seek = document.getElementById('p-seek');

  function play(m) {
    if (!current || current.slug !== m.slug) {
      current = m;
      audio.src = m.audio;
      audio.playbackRate = store.get('rate', 1);
      var pos = store.get('pos:' + m.slug, 0);
      audio.addEventListener('loadedmetadata', function once() {
        audio.removeEventListener('loadedmetadata', once);
        if (pos && pos < audio.duration - 5) audio.currentTime = pos;
      });
      document.getElementById('p-title').textContent = m.title;
      document.getElementById('p-title').href = '#/' + encodeURIComponent(m.slug);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: m.title, artist: (data && data.title) || 'Learning Lab', album: (m.topics || [])[0] || 'Lessons',
          artwork: [{ src: new URL('cover.png', location.href).href, sizes: '1400x1400', type: 'image/png' }]
        });
      }
      if (status(m.slug) === 'new') store.set('status:' + m.slug, 'started');
    }
    player.classList.remove('hidden');
    audio.play();
  }

  toggle.onclick = function () { if (audio.paused) audio.play(); else audio.pause(); };
  document.getElementById('p-back').onclick = function () { audio.currentTime = Math.max(0, audio.currentTime - 15); };
  document.getElementById('p-fwd').onclick = function () { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); };
  var rateBtn = document.getElementById('p-rate');
  rateBtn.textContent = store.get('rate', 1) + 'x';
  rateBtn.onclick = function () {
    var r = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] || 1;
    audio.playbackRate = r; store.set('rate', r); rateBtn.textContent = r + 'x';
  };
  seek.oninput = function () { if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration; };
  audio.onplay = function () { toggle.textContent = '\u275A\u275A'; };
  audio.onpause = function () { toggle.textContent = '\u25B6'; };
  audio.ontimeupdate = function () {
    if (!audio.duration) return;
    seek.value = (audio.currentTime / audio.duration) * 100;
    document.getElementById('p-cur').textContent = fmt(audio.currentTime);
    document.getElementById('p-dur').textContent = fmt(audio.duration);
    if (current) store.set('pos:' + current.slug, audio.currentTime);
  };
  audio.onended = function () { if (current) { store.set('status:' + current.slug, 'done'); store.set('pos:' + current.slug, 0); } };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
    navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
    navigator.mediaSession.setActionHandler('seekbackward', function () { audio.currentTime = Math.max(0, audio.currentTime - 15); });
    navigator.mediaSession.setActionHandler('seekforward', function () { audio.currentTime += 30; });
  }

  // ---- Subscribe sheet ----
  var sheet = document.getElementById('sub-sheet');
  document.getElementById('subscribe-btn').onclick = function () { document.getElementById('feed-url').value = feedUrl(); sheet.classList.remove('hidden'); };
  document.getElementById('sub-close').onclick = function () { sheet.classList.add('hidden'); };
  sheet.onclick = function (e) { if (e.target === sheet) sheet.classList.add('hidden'); };
  document.getElementById('copy-feed').onclick = function (e) {
    var inp = document.getElementById('feed-url'); inp.select();
    (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(function () {
      e.target.textContent = 'Copied';
    }, function () { document.execCommand('copy'); e.target.textContent = 'Copied'; });
  };

  // ---- Router ----
  function route() {
    if (!data) return;
    var h = decodeURIComponent((location.hash || '#/').slice(2));
    if (!h) renderLibrary();
    else if (h === 'next') renderNext();
    else renderLesson(h);
  }
  window.addEventListener('hashchange', route);

  fetch('lessons.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    data = d;
    document.getElementById('app-title').textContent = d.title || 'Learning Lab';
    var n = (d.lessons || []).length;
    var fresh = (d.lessons || []).filter(function (m) { return status(m.slug) === 'new'; }).length;
    document.getElementById('app-sub').textContent = n + ' lesson' + (n === 1 ? '' : 's') + (fresh ? ' · ' + fresh + ' new' : '');
    route();
  }).catch(function () {
    view.innerHTML = '<div class="lesson-card"><div class="font-medium">Couldn\u2019t load lessons</div><button class="pill mt-2" onclick="location.reload()">Retry</button></div>';
  });
})();
