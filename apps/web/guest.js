function trimApiBase(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function detectDefaultApiBase() {
  const { hostname, port } = window.location;
  if ((hostname === 'localhost' || hostname === '127.0.0.1') && port === '5173') {
    return 'http://localhost:4000';
  }
  return '';
}

function normalizeApiBaseCandidate(value) {
  const candidate = trimApiBase(value);
  if (!candidate) return '';

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function readInitialApiBase() {
  const stored = normalizeApiBaseCandidate(window.localStorage.getItem('pulse_api_base'));
  if (stored) return stored;

  const fromConfig = normalizeApiBaseCandidate(window.PULSE_CONFIG?.apiBase);
  if (fromConfig) {
    window.localStorage.setItem('pulse_api_base', fromConfig);
    return fromConfig;
  }

  return normalizeApiBaseCandidate(detectDefaultApiBase());
}

function readSupabaseConfig() {
  const url = String(window.PULSE_CONFIG?.supabaseUrl || '').trim();
  const anonKey = String(window.PULSE_CONFIG?.supabaseAnonKey || '').trim();
  if (!url || !anonKey) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    return { url: parsed.toString().replace(/\/+$/, ''), anonKey };
  } catch {
    return null;
  }
}

const PARTY_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const ALLOWED_SERVICES = new Set(['Apple Music']);
const FEED_POLL_MS = 3500;
const GUEST_TOKEN_KEY = 'whiteout_guest_token_v1';

const joinForm = document.getElementById('joinForm');
const partyCodeInput = document.getElementById('partyCode');
const joinResult = document.getElementById('joinResult');
const stopCheckingBtn = document.getElementById('stopCheckingBtn');

const requestPanel = document.getElementById('requestPanel');
const requestForm = document.getElementById('requestForm');
const requestResult = document.getElementById('requestResult');
const guestPartyName = document.getElementById('guestPartyName');
const guestMyRequestCount = document.getElementById('guestMyRequestCount');
const guestFeedCount = document.getElementById('guestFeedCount');
const guestLastDecision = document.getElementById('guestLastDecision');
const feedStatus = document.getElementById('feedStatus');
const guestFeedList = document.getElementById('guestFeedList');

const appleSearchSection = document.getElementById('appleSearchSection');
const appleSearchTermInput = document.getElementById('appleSearchTerm');
const appleSearchBtn = document.getElementById('appleSearchBtn');
const appleSearchStatus = document.getElementById('appleSearchStatus');
const appleSearchResults = document.getElementById('appleSearchResults');

const pickedSongPanel = document.getElementById('pickedSongPanel');
const pickedSongTitle = document.getElementById('pickedSongTitle');
const pickedSongArtist = document.getElementById('pickedSongArtist');
const pickedChangeBtn = document.getElementById('pickedChangeBtn');
const pickedSubmitBtn = document.getElementById('pickedSubmitBtn');

let apiBase = readInitialApiBase();
let supabaseClient = null;
let supabaseConfig = readSupabaseConfig();
let activePartyCode = '';
let activePartyName = '';
let activeDjReady = false;
let pickedSong = null;
let guestFeed = [];
let myRequestIds = new Set();

let joinDebounceTimer = null;
let joinInFlight = false;
let lastAutoJoinCode = '';
let joinPollTimer = null;
let joinPollCode = '';
let joinPollInFlight = false;
let joinPollAttempts = 0;
let feedPollTimer = null;
let feedPollInFlight = false;
let feedVoteInFlight = false;

function normalizePartyCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function setStatus(element, text, type = 'neutral') {
  if (!element) return;
  element.classList.remove('status-neutral', 'status-info', 'status-success', 'status-error');
  element.classList.add(`status-${type}`);
  element.textContent = text;
}

function setButtonLoading(button, loading, loadingLabel, idleLabel) {
  if (!button) return;
  button.disabled = loading;
  if (loadingLabel && idleLabel) {
    button.textContent = loading ? loadingLabel : idleLabel;
  }
}

function revealPanel(panel) {
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.classList.remove('panel-pop');
  void panel.offsetWidth;
  panel.classList.add('panel-pop');
}

function hidePanel(panel) {
  if (!panel) return;
  panel.classList.add('hidden');
  panel.classList.remove('panel-pop');
}

function nowLabel(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function readGuestToken() {
  let token = String(window.localStorage.getItem(GUEST_TOKEN_KEY) || '').trim();
  if (!token) {
    token =
      window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(GUEST_TOKEN_KEY, token);
  }
  return token;
}

function myRequestStorageKey(code) {
  const normalized = normalizePartyCode(code);
  return PARTY_CODE_PATTERN.test(normalized) ? `whiteout_guest_requests_${normalized}` : '';
}

function loadMyRequestIds(code) {
  const key = myRequestStorageKey(code);
  if (!key) return new Set();

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    const values = Array.isArray(parsed) ? parsed : [];
    return new Set(values.map((value) => String(value || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveMyRequestIds(code) {
  const key = myRequestStorageKey(code);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(myRequestIds)));
  } catch {
    // ignore
  }
}

function addMyRequestId(code, requestId) {
  const id = String(requestId || '').trim();
  if (!id) return;
  myRequestIds.add(id);
  saveMyRequestIds(code);
}

function makeAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function jsonp(urlInput, { timeoutMs = 9000, callbackParam = 'callback' } = {}) {
  const url = new URL(String(urlInput || '').trim());
  const callbackName = `__whiteout_jsonp_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  url.searchParams.set(callbackParam, callbackName);

  return await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        delete window[callbackName];
      } catch {
        // ignore
      }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out. Please retry.'));
    }, timeoutMs);

    window[callbackName] = (data) => {
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Network error. Please retry.'));
    };

    script.src = url.toString();
    document.head.appendChild(script);
  });
}

async function itunesSongSearch(term, limit = 10) {
  const q = String(term || '').trim();
  if (q.length < 2) return [];

  const queryParams = new URLSearchParams();
  queryParams.set('term', q);
  queryParams.set('media', 'music');
  queryParams.set('entity', 'song');
  queryParams.set('country', 'US');
  queryParams.set('limit', String(Math.max(1, Math.min(12, Number(limit) || 10))));

  const endpoints = [
    `https://itunes.apple.com/search?${queryParams.toString()}`,
    `https://ax.itunes.apple.com/WebObjects/MZStoreServices.woa/ws/wsSearch?${queryParams.toString()}`
  ];

  let data = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        data = await jsonp(endpoint, { timeoutMs: 9000, callbackParam: 'callback' });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 220 * (attempt + 1)));
      }
    }
    if (data) break;
  }

  if (!data) {
    throw lastError || new Error('Network error. Please retry.');
  }

  return (Array.isArray(data?.results) ? data.results : [])
    .map((row) => {
      const title = String(row?.trackName || '').trim();
      const artist = String(row?.artistName || '').trim();
      if (!title || !artist) return null;
      return {
        title,
        artist,
        album: String(row?.collectionName || '').trim(),
        url: String(row?.trackViewUrl || '').trim(),
        artworkUrl: String(row?.artworkUrl100 || '').trim()
      };
    })
    .filter(Boolean);
}

async function searchMusic(term) {
  if (supabaseConfig?.url && supabaseConfig?.anonKey) {
    try {
      const fnBase = supabaseConfig.url.replace('.supabase.co', '.functions.supabase.co');
      const endpoint = `${fnBase}/music-search`;
      const { signal, clear } = makeAbortSignal(9000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseConfig.anonKey,
            Authorization: `Bearer ${supabaseConfig.anonKey}`
          },
          body: JSON.stringify({ service: 'Apple Music', term, limit: 10 }),
          signal
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data?.results)) {
          return data.results;
        }
      } finally {
        clear();
      }
    } catch {
      // fall through to JSONP
    }
  }

  return await itunesSongSearch(term, 10);
}

async function apiRequest(path, options = {}) {
  if (!apiBase) {
    throw new Error('Whiteout live sync is not configured.');
  }

  const { signal, clear } = makeAbortSignal(options.timeoutMs || 9000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const res = await fetch(`${apiBase}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal
    });

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : {};
    if (!res.ok) {
      const error = new Error(data.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timed out. Please retry.');
    }
    throw error;
  } finally {
    clear();
  }
}

function initSupabase() {
  const cfg = readSupabaseConfig();
  supabaseConfig = cfg;
  if (!cfg) return null;
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;

  supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false }
  });
  return supabaseClient;
}

async function supaJoinParty(code) {
  const { data, error } = await supabaseClient.rpc('join_party', { p_code: code });
  if (error) throw new Error(error.message || 'Join failed');

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) throw new Error('Party not found');

  return {
    partyCode: String(row.party_code || code),
    partyName: String(row.party_name || '').trim(),
    djActive: Boolean(row.dj_active),
    expiresAt: row.expires_at ? String(row.expires_at) : null
  };
}

async function supaSubmitRequest(code, payload) {
  const { data, error } = await supabaseClient.rpc('submit_request', {
    p_code: code,
    p_service: payload.service,
    p_title: payload.title,
    p_artist: payload.artist,
    p_song_url: payload.songUrl || '',
    p_idempotency_key: payload.idempotencyKey || ''
  });

  if (error) throw new Error(error.message || 'Request failed');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error('Request failed');

  return {
    id: row.id,
    seqNo: row.seq_no,
    title: row.title,
    artist: row.artist,
    service: row.service,
    songUrl: row.song_url || '',
    createdAt: row.created_at || new Date().toISOString()
  };
}

async function supaFeed(code) {
  const { data, error } = await supabaseClient.rpc('guest_list_requests', {
    p_code: code,
    p_guest_token: readGuestToken()
  });

  if (error) throw new Error(error.message || 'Could not load the crowd wall');
  return {
    partyCode: code,
    requests: Array.isArray(data) ? data : []
  };
}

async function supaVote(code, requestId, value) {
  const { error } = await supabaseClient.rpc('guest_vote_request', {
    p_code: code,
    p_request_id: requestId,
    p_guest_token: readGuestToken(),
    p_value: value
  });
  if (error) throw new Error(error.message || 'Vote failed');
}

function sanitizeFeedEntry(entry) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;

  const statusRaw = String(entry?.status || 'queued').trim().toLowerCase();
  const status =
    statusRaw === 'played'
      ? 'played'
      : statusRaw === 'rejected'
        ? 'rejected'
        : statusRaw === 'approved'
          ? 'approved'
          : 'queued';

  return {
    id,
    seqNo: Number(entry?.seqNo ?? entry?.seq_no) || 0,
    title: String(entry?.title || 'Untitled').trim() || 'Untitled',
    artist: String(entry?.artist || 'Unknown').trim() || 'Unknown',
    service: String(entry?.service || 'Apple Music').trim() || 'Apple Music',
    status,
    playedAt: String(entry?.playedAt || entry?.played_at || '').trim(),
    playedBy: String(entry?.playedBy || entry?.played_by || '').trim(),
    createdAt: String(entry?.createdAt || entry?.created_at || new Date().toISOString()).trim(),
    upvotes: Math.max(0, Math.floor(Number(entry?.upvotes ?? 0) || 0)),
    downvotes: Math.max(0, Math.floor(Number(entry?.downvotes ?? 0) || 0)),
    score: Math.trunc(Number(entry?.score ?? 0) || 0),
    myVote: Math.trunc(Number(entry?.myVote ?? entry?.my_vote ?? 0) || 0)
  };
}

function statusLabel(status) {
  if (status === 'approved') return 'DJ approved';
  if (status === 'played') return 'Played';
  if (status === 'rejected') return 'Rejected';
  return 'In wall';
}

function statusRank(status) {
  if (status === 'approved') return 0;
  if (status === 'queued') return 1;
  if (status === 'played') return 2;
  return 3;
}

function updateSummary() {
  const mine = guestFeed.filter((entry) => myRequestIds.has(entry.id));
  if (guestMyRequestCount) guestMyRequestCount.textContent = String(mine.length);
  if (guestFeedCount) guestFeedCount.textContent = String(guestFeed.length);
  if (guestPartyName) {
    guestPartyName.textContent = activePartyName ? activePartyName : activePartyCode ? `Room ${activePartyCode}` : '';
  }

  const latestMine = mine
    .slice()
    .sort((a, b) => new Date(b.playedAt || b.createdAt).getTime() - new Date(a.playedAt || a.createdAt).getTime())[0];

  if (!activePartyCode) {
    guestLastDecision.textContent = 'Join a room to watch the live wall.';
  } else if (!mine.length) {
    guestLastDecision.textContent = 'You have not sent a track yet. Pick one and get on the wall.';
  } else if (latestMine.status === 'approved') {
    guestLastDecision.textContent = `DJ locked in "${latestMine.title}" by ${latestMine.artist}.`;
  } else if (latestMine.status === 'played') {
    guestLastDecision.textContent = `"${latestMine.title}" by ${latestMine.artist} has been played.`;
  } else if (latestMine.status === 'rejected') {
    guestLastDecision.textContent = `"${latestMine.title}" by ${latestMine.artist} was passed on.`;
  } else {
    guestLastDecision.textContent = `"${latestMine.title}" by ${latestMine.artist} is still live on the wall.`;
  }
}

function renderFeed() {
  if (!guestFeedList) return;
  guestFeedList.textContent = '';

  if (!guestFeed.length) {
    const empty = document.createElement('p');
    empty.className = 'micro-note';
    empty.textContent = activePartyCode
      ? 'No requests on the wall yet. Be the first one in.'
      : 'Join a room to see what everyone is requesting.';
    guestFeedList.appendChild(empty);
    updateSummary();
    return;
  }

  const sorted = guestFeed
    .slice()
    .sort((a, b) => {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      if (b.score !== a.score) return b.score - a.score;
      if (b.seqNo !== a.seqNo) return b.seqNo - a.seqNo;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  for (const entry of sorted) {
    const card = document.createElement('article');
    card.className = `feed-card feed-${entry.status}`;
    if (myRequestIds.has(entry.id)) {
      card.classList.add('is-own');
    }

    const top = document.createElement('div');
    top.className = 'feed-card-top';

    const seq = document.createElement('span');
    seq.className = 'feed-seq';
    seq.textContent = entry.seqNo > 0 ? `#${entry.seqNo}` : '#?';

    const badge = document.createElement('span');
    badge.className = `feed-badge feed-badge-status-${entry.status}`;
    badge.textContent = statusLabel(entry.status);

    top.append(seq, badge);

    const title = document.createElement('p');
    title.className = 'feed-title';
    title.textContent = entry.title;

    const artist = document.createElement('p');
    artist.className = 'feed-sub';
    artist.textContent = entry.artist;

    const meta = document.createElement('p');
    meta.className = 'feed-note';
    meta.textContent = `${entry.service} • ${myRequestIds.has(entry.id) ? 'Your request • ' : ''}${nowLabel(entry.playedAt || entry.createdAt)}`;

    const voteRow = document.createElement('div');
    voteRow.className = 'feed-votes';

    const upvoteBtn = document.createElement('button');
    upvoteBtn.type = 'button';
    upvoteBtn.className = `vote-btn ${entry.myVote === 1 ? 'is-active' : ''}`;
    upvoteBtn.textContent = `▲ ${entry.upvotes}`;
    upvoteBtn.disabled = !activePartyCode || feedVoteInFlight || entry.status === 'played' || entry.status === 'rejected';
    upvoteBtn.addEventListener('click', () => handleVote(entry, 1));

    const score = document.createElement('span');
    score.className = 'vote-score';
    score.textContent = entry.score > 0 ? `+${entry.score}` : String(entry.score);

    const downvoteBtn = document.createElement('button');
    downvoteBtn.type = 'button';
    downvoteBtn.className = `vote-btn ${entry.myVote === -1 ? 'is-active is-negative' : 'is-negative'}`;
    downvoteBtn.textContent = `▼ ${entry.downvotes}`;
    downvoteBtn.disabled = !activePartyCode || feedVoteInFlight || entry.status === 'played' || entry.status === 'rejected';
    downvoteBtn.addEventListener('click', () => handleVote(entry, -1));

    voteRow.append(upvoteBtn, score, downvoteBtn);
    card.append(top, title, artist, meta, voteRow);
    guestFeedList.appendChild(card);
  }

  updateSummary();
}

function stopFeedPolling() {
  if (feedPollTimer) {
    clearInterval(feedPollTimer);
    feedPollTimer = null;
  }
  feedPollInFlight = false;
}

async function refreshFeed({ silent = false } = {}) {
  if (!activePartyCode || feedPollInFlight) return;
  feedPollInFlight = true;

  if (!silent) {
    setStatus(feedStatus, 'Refreshing the crowd wall...', 'info');
  }

  try {
    const payload = supabaseClient
      ? await supaFeed(activePartyCode)
      : await apiRequest(`/api/parties/${activePartyCode}/feed?guestToken=${encodeURIComponent(readGuestToken())}`);

    guestFeed = (Array.isArray(payload?.requests) ? payload.requests : []).map(sanitizeFeedEntry).filter(Boolean);
    renderFeed();
    setStatus(feedStatus, activeDjReady ? 'Live wall synced.' : 'Room found. Waiting for the DJ to go live.', activeDjReady ? 'success' : 'info');
  } catch (error) {
    if (!silent) {
      setStatus(feedStatus, error.message || 'Could not load the crowd wall.', 'error');
    }
  } finally {
    feedPollInFlight = false;
  }
}

function startFeedPolling() {
  stopFeedPolling();
  if (!activePartyCode) return;
  refreshFeed({ silent: false });
  feedPollTimer = setInterval(() => {
    refreshFeed({ silent: true });
  }, FEED_POLL_MS);
}

async function handleVote(entry, requestedValue) {
  if (!activePartyCode || feedVoteInFlight) return;
  feedVoteInFlight = true;
  const nextValue = entry.myVote === requestedValue ? 0 : requestedValue;
  setStatus(feedStatus, nextValue === 0 ? 'Removing your vote...' : 'Saving your vote...', 'info');

  try {
    if (supabaseClient) {
      await supaVote(activePartyCode, entry.id, nextValue);
    } else {
      await apiRequest(`/api/parties/${activePartyCode}/requests/${entry.id}/vote`, {
        method: 'POST',
        body: {
          guestToken: readGuestToken(),
          value: nextValue
        }
      });
    }

    await refreshFeed({ silent: false });
  } catch (error) {
    setStatus(feedStatus, error.message || 'Could not save your vote.', 'error');
  } finally {
    feedVoteInFlight = false;
  }
}

function stopJoinPolling(message) {
  if (joinPollTimer) {
    clearInterval(joinPollTimer);
    joinPollTimer = null;
  }

  joinPollCode = '';
  joinPollAttempts = 0;
  joinPollInFlight = false;
  if (stopCheckingBtn) stopCheckingBtn.classList.add('hidden');
  if (message) setStatus(joinResult, message, 'neutral');
}

function setActiveParty(code, partyName, djActive) {
  activePartyCode = code;
  activePartyName = String(partyName || '').trim();
  activeDjReady = Boolean(djActive);
  myRequestIds = loadMyRequestIds(code);
  updateSummary();
  startFeedPolling();
}

function startJoinPolling(code) {
  const maxAttempts = 60;
  const intervalMs = 2000;

  stopJoinPolling();
  joinPollCode = code;
  joinPollAttempts = 0;
  joinPollInFlight = false;
  if (stopCheckingBtn) stopCheckingBtn.classList.remove('hidden');

  joinPollTimer = setInterval(async () => {
    if (joinPollInFlight) return;
    joinPollInFlight = true;
    joinPollAttempts += 1;

    try {
      const data = supabaseClient
        ? await supaJoinParty(code)
        : await apiRequest(`/api/parties/${code}/join`, { method: 'POST', timeoutMs: 8000 });

      setActiveParty(code, data?.partyName || '', Boolean(data?.djActive));
      if (data.djActive) {
        stopJoinPolling();
        revealPanel(requestPanel);
        setStatus(joinResult, `DJ is live. You are in ${code}${activePartyName ? `: ${activePartyName}` : ''}.`, 'success');
        setStatus(feedStatus, 'Live wall synced.', 'success');
        return;
      }

      if (joinPollAttempts >= maxAttempts) {
        stopJoinPolling('Still waiting for the DJ to go live.');
        return;
      }

      setStatus(joinResult, `Room found. Waiting for DJ... (${joinPollAttempts}/${maxAttempts})`, 'info');
      setStatus(feedStatus, 'Room found. Waiting for the DJ to go live.', 'info');
    } catch (error) {
      stopJoinPolling(error.message || 'Could not check room status.');
    } finally {
      joinPollInFlight = false;
    }
  }, intervalMs);
}

async function joinPartyByCode(codeInput) {
  const code = normalizePartyCode(codeInput);
  if (!PARTY_CODE_PATTERN.test(code)) {
    setStatus(joinResult, 'Room code must be 6 letters or numbers.', 'error');
    setStatus(feedStatus, 'Enter a valid room code to load the crowd wall.', 'neutral');
    activePartyCode = '';
    activePartyName = '';
    activeDjReady = false;
    stopFeedPolling();
    hidePanel(requestPanel);
    updateSummary();
    return false;
  }

  setStatus(joinResult, `Checking room ${code}...`, 'info');

  try {
    const data = supabaseClient
      ? await supaJoinParty(code)
      : await apiRequest(`/api/parties/${code}/join`, { method: 'POST' });

    setActiveParty(code, data?.partyName || '', Boolean(data?.djActive));

    if (!data.djActive) {
      hidePanel(requestPanel);
      setStatus(joinResult, 'Room found. Waiting for the DJ to go live...', 'info');
      setStatus(feedStatus, 'Room found. The crowd wall is live. Requests unlock when the DJ connects.', 'info');
      startJoinPolling(code);
      return false;
    }

    stopJoinPolling();
    revealPanel(requestPanel);
    setStatus(joinResult, `Connected to ${code}${activePartyName ? `: ${activePartyName}` : ''}.`, 'success');
    setStatus(feedStatus, 'Live wall synced.', 'success');
    if (appleSearchTermInput) appleSearchTermInput.focus();
    return true;
  } catch (error) {
    activePartyCode = '';
    activePartyName = '';
    activeDjReady = false;
    stopFeedPolling();
    hidePanel(requestPanel);
    stopJoinPolling();
    updateSummary();
    setStatus(joinResult, error.message || 'Unable to join this room.', 'error');
    setStatus(feedStatus, 'Could not load the crowd wall.', 'error');
    return false;
  }
}

function scheduleAutoJoin(codeInput) {
  const normalized = normalizePartyCode(codeInput);
  if (!PARTY_CODE_PATTERN.test(normalized)) return;
  if (normalized === activePartyCode || normalized === lastAutoJoinCode) return;

  if (joinDebounceTimer) clearTimeout(joinDebounceTimer);
  joinDebounceTimer = setTimeout(async () => {
    if (joinInFlight) return;
    joinInFlight = true;
    lastAutoJoinCode = normalized;
    try {
      await joinPartyByCode(normalized);
    } finally {
      joinInFlight = false;
    }
  }, 420);
}

function fillRequestFieldsFromSearchResult(result) {
  const titleInput = document.getElementById('title');
  const artistInput = document.getElementById('artist');
  if (titleInput) titleInput.value = result.title || '';
  if (artistInput) artistInput.value = result.artist || '';

  pickedSong = {
    service: 'Apple Music',
    title: String(result.title || '').trim(),
    artist: String(result.artist || '').trim(),
    songUrl: String(result.url || '').trim()
  };

  pickedSongTitle.textContent = pickedSong.title || 'Selected song';
  pickedSongArtist.textContent = pickedSong.artist ? `by ${pickedSong.artist}` : '';
  pickedSongPanel.classList.remove('hidden');
  appleSearchResults.textContent = '';
  appleSearchTermInput.value = '';
  setStatus(appleSearchStatus, 'Song selected. Tap Send Request.', 'success');
}

function renderAppleSearchResults(items) {
  appleSearchResults.textContent = '';

  if (!items.length) {
    const note = document.createElement('p');
    note.className = 'micro-note';
    note.textContent = 'No results found.';
    appleSearchResults.appendChild(note);
    return;
  }

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'search-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Select ${item.title} by ${item.artist}`);
    card.addEventListener('click', () => fillRequestFieldsFromSearchResult(item));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fillRequestFieldsFromSearchResult(item);
      }
    });

    const image = document.createElement('img');
    image.alt = `${item.title} artwork`;
    image.src = item.artworkUrl || '';

    const meta = document.createElement('div');
    meta.className = 'search-meta';

    const title = document.createElement('p');
    title.className = 'search-title';
    title.textContent = item.title || 'Unknown title';

    const sub = document.createElement('p');
    sub.className = 'search-sub';
    sub.textContent = `${item.artist || 'Unknown artist'}${item.album ? ` • ${item.album}` : ''}`;

    meta.append(title, sub);
    card.append(image, meta);
    appleSearchResults.appendChild(card);
  }
}

async function runAppleMusicSearch() {
  const term = String(appleSearchTermInput?.value || '').trim();
  if (term.length < 2) {
    setStatus(appleSearchStatus, 'Type at least 2 characters to search.', 'error');
    return;
  }

  setButtonLoading(appleSearchBtn, true, 'Searching...', 'Search');
  setStatus(appleSearchStatus, 'Searching Apple Music...', 'info');

  try {
    const results = await searchMusic(term);
    renderAppleSearchResults(results);
    setStatus(appleSearchStatus, results.length ? `Found ${results.length} tracks. Tap one to send it.` : 'No results. Try another search.', results.length ? 'success' : 'neutral');
  } catch (error) {
    setStatus(appleSearchStatus, error.message || 'Search failed.', 'error');
  } finally {
    setButtonLoading(appleSearchBtn, false, 'Searching...', 'Search');
  }
}

function makeIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isValidSongUrl(urlText, service) {
  if (!urlText) return false;
  if (!ALLOWED_SERVICES.has(service)) return false;

  try {
    const parsed = new URL(urlText);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('music.apple.com');
  } catch {
    return false;
  }
}

async function submitSongRequest(input) {
  if (!activePartyCode) {
    setStatus(requestResult, 'Join a live room first.', 'error');
    return false;
  }

  const service = String(input?.service || '').trim();
  const title = String(input?.title || '').trim();
  const artist = String(input?.artist || '').trim();
  const songUrl = String(input?.songUrl || '').trim();

  if (!ALLOWED_SERVICES.has(service)) {
    setStatus(requestResult, 'Choose a valid music service.', 'error');
    return false;
  }

  if (!title || !artist) {
    setStatus(requestResult, 'Song title and artist are required.', 'error');
    return false;
  }

  if (!isValidSongUrl(songUrl, service)) {
    setStatus(requestResult, 'Pick a valid Apple Music result first.', 'error');
    return false;
  }

  setButtonLoading(pickedSubmitBtn, true, 'Sending...', 'Send Request');
  setStatus(requestResult, 'Sending your request to the booth...', 'info');

  try {
    const idempotencyKey = makeIdempotencyKey();
    const data = supabaseClient
      ? await supaSubmitRequest(activePartyCode, { service, title, artist, songUrl, idempotencyKey })
      : await apiRequest(`/api/parties/${activePartyCode}/requests`, {
          method: 'POST',
          headers: { 'X-Idempotency-Key': idempotencyKey },
          body: { service, title, artist, songUrl }
        });

    addMyRequestId(activePartyCode, data.id);
    pickedSong = null;
    pickedSongPanel.classList.add('hidden');
    appleSearchResults.textContent = '';
    appleSearchTermInput.value = '';
    setStatus(requestResult, `Queued #${data.seqNo}: ${data.title} - ${data.artist}`, 'success');
    setStatus(appleSearchStatus, 'Request sent to the DJ.', 'success');
    await refreshFeed({ silent: false });
    return true;
  } catch (error) {
    if (error.status === 409) {
      hidePanel(requestPanel);
      activeDjReady = false;
      setStatus(joinResult, 'DJ is not active right now. Waiting for the DJ to reconnect...', 'info');
      startJoinPolling(activePartyCode || normalizePartyCode(partyCodeInput.value));
    }

    setStatus(requestResult, error.message || 'Request failed.', 'error');
    return false;
  } finally {
    setButtonLoading(pickedSubmitBtn, false, 'Sending...', 'Send Request');
  }
}

function readPartyCodeFromUrl() {
  const params = new URLSearchParams(window.location.search || '');
  return normalizePartyCode(params.get('partyCode') || params.get('code'));
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = normalizePartyCode(partyCodeInput.value);
  lastAutoJoinCode = code;
  await joinPartyByCode(code);
});

partyCodeInput.addEventListener('input', () => {
  partyCodeInput.value = normalizePartyCode(partyCodeInput.value);
  stopJoinPolling();

  const normalized = normalizePartyCode(partyCodeInput.value);
  if (activePartyCode && normalized !== activePartyCode) {
    activePartyCode = '';
    activePartyName = '';
    activeDjReady = false;
    stopFeedPolling();
    guestFeed = [];
    myRequestIds = new Set();
    hidePanel(requestPanel);
    renderFeed();
    setStatus(joinResult, 'Room code changed. Tap Join to reconnect.', 'neutral');
    setStatus(feedStatus, 'Enter the new room code to load the crowd wall.', 'neutral');
  }

  scheduleAutoJoin(normalized);
});

stopCheckingBtn.addEventListener('click', () => {
  stopJoinPolling('Stopped checking. Tap Join to try again.');
});

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pickedSong) {
    setStatus(requestResult, 'Pick a song from the results first.', 'error');
    return;
  }

  await submitSongRequest(pickedSong);
});

if (appleSearchBtn) {
  appleSearchBtn.addEventListener('click', () => runAppleMusicSearch());
}

appleSearchTermInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runAppleMusicSearch();
  }
});

let appleTypeaheadTimer = null;
let appleTypeaheadLast = '';
appleSearchTermInput.addEventListener('input', () => {
  const term = String(appleSearchTermInput.value || '').trim();
  if (term === appleTypeaheadLast) return;
  appleTypeaheadLast = term;

  if (appleTypeaheadTimer) clearTimeout(appleTypeaheadTimer);
  appleTypeaheadTimer = setTimeout(() => {
    if (String(appleSearchTermInput.value || '').trim().length >= 2) {
      runAppleMusicSearch();
    } else {
      appleSearchResults.textContent = '';
      setStatus(appleSearchStatus, 'Type at least 2 characters to search.', 'neutral');
    }
  }, 240);
});

if (pickedChangeBtn) {
  pickedChangeBtn.addEventListener('click', () => {
    pickedSong = null;
    pickedSongPanel.classList.add('hidden');
    setStatus(requestResult, 'Pick a song from the results.', 'neutral');
    appleSearchTermInput.focus();
  });
}

if (pickedSubmitBtn) {
  pickedSubmitBtn.addEventListener('click', async () => {
    if (!pickedSong) {
      setStatus(requestResult, 'Pick a song from the results first.', 'error');
      return;
    }
    await submitSongRequest(pickedSong);
  });
}

initSupabase();
renderFeed();

if (!supabaseClient && !apiBase) {
  setStatus(joinResult, 'Whiteout live sync is not configured yet.', 'error');
  setStatus(feedStatus, 'Whiteout live sync is not configured yet.', 'error');
}

const codeFromUrl = readPartyCodeFromUrl();
if (PARTY_CODE_PATTERN.test(codeFromUrl)) {
  partyCodeInput.value = codeFromUrl;
  setStatus(joinResult, `Room code ${codeFromUrl} loaded. Checking now...`, 'info');
  lastAutoJoinCode = codeFromUrl;
  joinPartyByCode(codeFromUrl);
}
