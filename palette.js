let allTabs = [];
let filteredTabs = [];
let selectedIndex = 0;
let cycleCount = 0;
let openCombo = null;
let openerTabId = null;
let viewMode = 'tiles';
let tabPreviews = {};
let tabsLoaded = false;
// Pins are stored by URL, not tab id: ids are recycled every restart.
let pinnedUrls = [];

function isSafeFavicon(url) {
  if (!url) return false;
  return /^(https?:|data:)/i.test(url);
}

function isDisplayableTab(tab) {
  return (tab.url || '').toLowerCase() !== 'about:blank';
}

function parseShortcut(s) {
  if (!s) return null;
  const combo = { meta: false, ctrl: false, shift: false, alt: false, key: '' };
  s.split('+').forEach(function(p) {
    const lower = p.toLowerCase().trim();
    if (lower === 'command') combo.meta = true;
    else if (lower === 'ctrl' || lower === 'macctrl') combo.ctrl = true;
    else if (lower === 'shift') combo.shift = true;
    else if (lower === 'alt' || lower === 'option') combo.alt = true;
    else if (lower) combo.key = lower;
  });
  return combo;
}

function comboModifierStillHeld(combo, e) {
  if (!combo) return false;
  return (combo.meta && e.metaKey)
    || (combo.ctrl && e.ctrlKey)
    || (combo.alt && e.altKey)
    || (combo.shift && e.shiftKey);
}

document.addEventListener('DOMContentLoaded', function() {
  const params = new URLSearchParams(location.search);
  openerTabId = parseInt(params.get('opener'), 10) || null;

  chrome.commands.getAll(function(commands) {
    const cmd = (commands || []).find(function(c) { return c.name === 'open-and-cycle'; });
    openCombo = parseShortcut(cmd && cmd.shortcut);
  });

  loadTabs();
  loadViewSettings();

  const search = document.getElementById('search');
  search.addEventListener('input', function() {
    cycleCount = 0;
    // A new query is a new list — restart from the top so the highlight never
    // sits mid-list or out of range after filtering.
    selectedIndex = 0;
    filterTabs();
    render();
  });

  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('keyup', handleKeyup, true);

  // Previews for other windows arrive shortly after the palette opens.
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'session' || !changes.tabPreviews) return;
      if (viewMode === 'list') return;
      tabPreviews = changes.tabPreviews.newValue || {};
      render();
    });
  }

  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.type === 'cycle') {
      cycleCount++;
      cycleNext();
    }
  });
});

// The popup only ever writes one of the three known modes — anything else
// falls back to tiles.
function normalizeViewMode(value) {
  return value === 'list' || value === 'preview' ? value : 'tiles';
}

// Never let a settings/preview read block the tab list: it renders on its own,
// then re-renders if a view mode or previews arrive.
function loadViewSettings() {
  safeStorageGet('local', { viewMode: 'tiles', pinnedUrls: [] }, function(settings) {
    viewMode = normalizeViewMode(settings.viewMode);
    pinnedUrls = Array.isArray(settings.pinnedUrls) ? settings.pinnedUrls : [];
    // Pins can land after the tabs did, which re-sorts the list under the
    // selection — re-anchor it on the tab it was already pointing at.
    if (tabsLoaded) {
      const selected = filteredTabs[selectedIndex];
      applyOrder(selected && selected.id);
      if (!selected) selectedIndex = initialSelection();
    }
    render();
    if (viewMode === 'list') return;
    safeStorageGet('session', { tabPreviews: {} }, function(session) {
      tabPreviews = session.tabPreviews || {};
      render();
    });
  });
}

function safeStorageGet(area, defaults, callback) {
  try {
    const store = chrome.storage && chrome.storage[area];
    if (!store) return;
    store.get(defaults, function(result) {
      if (chrome.runtime.lastError) return;
      callback(result || defaults);
    });
  } catch (_) {
    // storage unavailable (e.g. missing permission) — keep defaults
  }
}

function loadTabs() {
  chrome.windows.getAll({ populate: true }, function(windows) {
    chrome.windows.getCurrent(function(currentWin) {
      const paletteWindowId = currentWin ? currentWin.id : null;
      const paletteUrl = location.href.split('?')[0];

      function collect(skipPaletteWindow) {
        const items = [];
        (windows || []).forEach(function(win) {
          if (skipPaletteWindow && win.id === paletteWindowId) return;
          (win.tabs || []).forEach(function(tab) {
            if (!isDisplayableTab(tab)) return;
            // Never list the palette itself, whichever window it landed in.
            if ((tab.url || '').split('?')[0] === paletteUrl) return;
            items.push({
              id: tab.id,
              windowId: win.id,
              title: tab.title || '',
              url: tab.url || '',
              favIconUrl: isSafeFavicon(tab.favIconUrl) ? tab.favIconUrl : null,
              lastAccessed: tab.lastAccessed,
              active: tab.id === openerTabId
            });
          });
        });
        return items;
      }

      // Skipping the palette's own window is the normal path, but if that
      // leaves nothing (e.g. getCurrent resolved to a real browser window),
      // fall back to every tab except the palette page.
      allTabs = collect(true);
      if (allTabs.length === 0) allTabs = collect(false);

      tabsLoaded = true;
      applyOrder();
      selectedIndex = initialSelection();
      render();
    });
  });
}

function isPinned(url) {
  return pinnedUrls.indexOf(url) !== -1;
}

// Pinned tabs first, each group still ordered by how recently it was used.
// Pass a tab id to keep that tab selected across the re-sort.
function applyOrder(followTabId) {
  allTabs.forEach(function(item) { item.pinned = isPinned(item.url); });
  allTabs.sort(function(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  filterTabs();
  if (followTabId == null) return;
  const moved = filteredTabs.findIndex(function(t) { return t.id === followTabId; });
  if (moved !== -1) selectedIndex = moved;
}

// Open on the tab you came from — with pins in play it is no longer first.
function initialSelection() {
  const current = filteredTabs.findIndex(function(t) { return t.active; });
  return current === -1 ? 0 : current;
}

function togglePin(item) {
  const index = pinnedUrls.indexOf(item.url);
  if (index === -1) pinnedUrls.push(item.url);
  else pinnedUrls.splice(index, 1);

  try {
    chrome.storage.local.set({ pinnedUrls: pinnedUrls }, function() {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // storage unavailable — the pin still applies for this session
  }

  // Re-sorting moves the tab, so follow it and keep it selected.
  applyOrder(item.id);
  render();
}

// Tile view is a real grid, so up/down should move a whole row. The column
// count is measured from the laid-out tiles (not the CSS string), so it stays
// right across resizes, scrollbars, and partial last rows.
function gridColumnCount() {
  if (viewMode !== 'tiles') return 1;
  const list = document.getElementById('list');
  const items = list ? list.querySelectorAll('.item') : null;
  if (items && items.length > 1) {
    const firstTop = items[0].getBoundingClientRect().top;
    const TOLERANCE_PX = 4;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      if (Math.abs(items[i].getBoundingClientRect().top - firstTop) <= TOLERANCE_PX) count++;
      else break;
    }
    if (count >= 1) return count;
  } else if (items && items.length === 1) {
    return 1;
  }
  // Fallback before first layout: parse the resolved grid track list.
  if (list) {
    const columns = getComputedStyle(list).gridTemplateColumns;
    if (columns && columns !== 'none') {
      const count = columns.split(/\s+/).filter(Boolean).length;
      if (count >= 1) return count;
    }
  }
  return 1;
}

// Clamp a stale index back into range (filtering or tab closes can shrink the
// list under the selection).
function normalizeSelection() {
  if (filteredTabs.length === 0) {
    selectedIndex = 0;
    return;
  }
  if (!Number.isInteger(selectedIndex)) selectedIndex = 0;
  selectedIndex = ((selectedIndex % filteredTabs.length) + filteredTabs.length) % filteredTabs.length;
}

function moveHorizontal(delta) {
  if (filteredTabs.length === 0) return;
  normalizeSelection();
  selectedIndex = (selectedIndex + delta + filteredTabs.length) % filteredTabs.length;
  updateSelection(true);
}

function moveVertical(delta) {
  if (filteredTabs.length === 0) return;
  normalizeSelection();
  const columns = gridColumnCount();
  if (columns <= 1) {
    moveHorizontal(delta);
    return;
  }
  const len = filteredTabs.length;
  const rows = Math.ceil(len / columns);
  if (rows <= 1) {
    // Single row: up goes to the first tile, down to the last.
    selectedIndex = delta < 0 ? 0 : len - 1;
    updateSelection(true);
    return;
  }
  const row = Math.floor(selectedIndex / columns);
  const col = selectedIndex % columns;
  const newRow = (((row + delta) % rows) + rows) % rows;
  let target = newRow * columns + col;
  if (target >= len) {
    // The last row is short and has no tile in this column — land on the
    // nearest tile instead of staying put.
    target = len - 1;
  }
  selectedIndex = target;
  updateSelection(true);
}

// Left/right drive the grid, but not while the caret still has somewhere to go
// inside a typed query — editing the search text wins there.
function caretCanMove(direction) {
  const search = document.getElementById('search');
  if (!search || document.activeElement !== search) return false;
  const value = search.value || '';
  if (!value) return false;
  if (search.selectionStart == null || search.selectionEnd == null) return false;
  if (search.selectionStart !== search.selectionEnd) return true;
  return direction < 0 ? search.selectionStart > 0 : search.selectionStart < value.length;
}

function handleKeydown(e) {
  const grid = viewMode === 'tiles';
  // Holding shift forces grid navigation, so arrows still move the selection
  // instead of the caret (or selecting text) while a query is typed.
  const forceNav = e.shiftKey;
  if (e.key === 'ArrowDown') {
    cycleCount = 0;
    if (grid) moveVertical(1); else moveHorizontal(1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    cycleCount = 0;
    if (grid) moveVertical(-1); else moveHorizontal(-1);
    e.preventDefault();
  } else if (e.key === 'ArrowRight' && grid && (forceNav || !caretCanMove(1))) {
    cycleCount = 0;
    moveHorizontal(1);
    e.preventDefault();
  } else if (e.key === 'ArrowLeft' && grid && (forceNav || !caretCanMove(-1))) {
    cycleCount = 0;
    moveHorizontal(-1);
    e.preventDefault();
  } else if (e.key === 'Home') {
    cycleCount = 0;
    if (filteredTabs.length > 0) {
      selectedIndex = 0;
      updateSelection(true);
    }
    e.preventDefault();
  } else if (e.key === 'End') {
    cycleCount = 0;
    if (filteredTabs.length > 0) {
      selectedIndex = filteredTabs.length - 1;
      updateSelection(true);
    }
    e.preventDefault();
  } else if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
    const item = filteredTabs[selectedIndex];
    if (item) togglePin(item);
    e.preventDefault();
  } else if (e.metaKey && (e.key === 'w' || e.key === 'W')) {
    closeSelectedTab();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    selectCurrent();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeWindow();
    e.preventDefault();
  }
}

function handleKeyup(e) {
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
  if (cycleCount === 0) return;
  if (!comboModifierStillHeld(openCombo, e)) {
    selectCurrent();
  }
}

function cycleNext() {
  moveHorizontal(1);
}

function cyclePrev() {
  moveHorizontal(-1);
}

// Move the highlight without rebuilding the list — a full render would reload
// every preview image and flicker.
function updateSelection(scroll) {
  normalizeSelection();
  const items = document.getElementById('list').querySelectorAll('.item');
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === selectedIndex);
  }
  const sel = items[selectedIndex];
  if (sel && scroll) sel.scrollIntoView({ block: 'nearest' });
}

function filterTabs() {
  const search = document.getElementById('search');
  const q = (search ? search.value : '').toLowerCase();
  filteredTabs = allTabs.filter(function(item) {
    return item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q);
  });
  // Background re-renders (previews, pins) must not move the highlight — just
  // clamp a stale index into range. Search typing resets to 0 explicitly.
  if (filteredTabs.length === 0) selectedIndex = 0;
  else if (selectedIndex >= filteredTabs.length) selectedIndex = filteredTabs.length - 1;
  else if (selectedIndex < 0) selectedIndex = 0;
}

function closeSelectedTab() {
  const item = filteredTabs[selectedIndex];
  if (!item) return;
  const closedIndex = selectedIndex;

  chrome.tabs.remove(item.id, function() {
    if (chrome.runtime.lastError) return;
    allTabs = allTabs.filter(function(tab) { return tab.id !== item.id; });
    filterTabs();
    selectedIndex = Math.max(0, Math.min(closedIndex, filteredTabs.length - 1));
    render();
  });
}

const PIN_ICON = 'M9.2 1.6l5.2 5.2-1.3 1.3-1-.3-2.6 2.6.2 2.2-1.2 1.2-3-3L2 14l-.4-.4 3.2-3.5-3-3L3 5.9l2.2.2 2.6-2.6-.3-1z';

// The tab you opened the switcher from — bold text alone was invisible in tile
// view, where titles are already bold.
function currentBadge() {
  const badge = document.createElement('span');
  badge.className = 'badge-current';
  badge.textContent = 'Current';
  return badge;
}

function buildPinButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pin';
  button.title = item.pinned ? 'Unpin tab' : 'Pin tab to the top';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(!!item.pinned));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PIN_ICON);
  svg.appendChild(path);
  button.appendChild(svg);

  button.addEventListener('click', function(e) {
    // The row/tile itself switches tabs — pinning must not.
    e.stopPropagation();
    e.preventDefault();
    togglePin(item);
  });
  return button;
}

// Measured once per tab, then reused across re-renders.
const previewTone = {};
// Above this average luminance (0-255) the corner counts as a light surface.
const LIGHT_THRESHOLD = 150;

function applyTone(thumb, tone) {
  if (!tone) return;
  thumb.classList.toggle('on-light', tone === 'light');
}

// Average the luminance of the corner the pin sits in, off a downscaled copy
// of the screenshot. Data URLs are same-origin, so the canvas stays readable.
function measureTone(img, tabId) {
  if (previewTone[tabId]) return previewTone[tabId];
  try {
    const w = 32;
    const h = 20;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    const fromX = Math.round(w * 0.55);
    const data = ctx.getImageData(fromX, 0, w - fromX, Math.round(h * 0.4)).data;
    let total = 0;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      pixels++;
    }
    if (!pixels) return null;

    const tone = total / pixels > LIGHT_THRESHOLD ? 'light' : 'dark';
    previewTone[tabId] = tone;
    return tone;
  } catch (_) {
    // Unreadable canvas — keep the default dark scrim, which works either way.
    return null;
  }
}

// Screenshot if we have one, otherwise a tile built from the site's favicon
// (falling back to the first letter of the title).
function buildThumb(item) {
  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const preview = tabPreviews[item.id];
  if (preview && preview.dataUrl) {
    const shot = document.createElement('img');
    shot.className = 'shot';
    shot.src = preview.dataUrl;
    shot.alt = '';
    thumb.appendChild(shot);
    // Overlay controls sit on the screenshot, whose brightness varies per
    // page — measure it so they can flip between a light and dark treatment.
    const known = previewTone[item.id];
    if (known) applyTone(thumb, known);
    shot.addEventListener('load', function() {
      applyTone(thumb, measureTone(shot, item.id));
    });
    return thumb;
  }

  thumb.classList.add('fallback');
  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.textContent = (item.title || item.url || '?').trim().charAt(0).toUpperCase() || '?';

  if (item.favIconUrl) {
    const mark = document.createElement('img');
    mark.className = 'mark';
    mark.src = item.favIconUrl;
    mark.alt = '';
    mark.onerror = function() {
      mark.remove();
      thumb.appendChild(letter);
    };
    thumb.appendChild(mark);
  } else {
    thumb.appendChild(letter);
  }
  return thumb;
}

function render() {
  const list = document.getElementById('list');
  list.className = viewMode === 'tiles' ? 'tiles' : (viewMode === 'preview' ? 'preview' : '');
  list.innerHTML = '';
  if (!tabsLoaded) return;
  if (filteredTabs.length === 0) {
    list.innerHTML = '<div class="empty">No tabs found</div>';
    return;
  }
  filteredTabs.forEach(function(item, index) {
    const div = document.createElement('div');
    let cls = 'item';
    if (index === selectedIndex) cls += ' selected';
    if (item.active) cls += ' active';
    if (item.pinned) cls += ' pinned';
    div.className = cls;

    const pin = buildPinButton(item);
    if (viewMode === 'tiles') {
      const thumb = buildThumb(item);
      thumb.appendChild(pin);
      if (item.active) thumb.appendChild(currentBadge());
      div.appendChild(thumb);
    } else if (viewMode === 'preview') {
      div.appendChild(buildThumb(item));
    }

    const fav = document.createElement('img');
    fav.className = 'favicon';
    // Keep the slot (titles stay aligned) but show nothing when there is no
    // icon — an empty <img> renders as a broken-image box.
    if (item.favIconUrl) fav.src = item.favIconUrl;
    else fav.style.visibility = 'hidden';
    fav.onerror = function() { fav.style.visibility = 'hidden'; };

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title || '(untitled)';

    const url = document.createElement('span');
    url.className = 'url';
    try { url.textContent = new URL(item.url).hostname; } catch (_) { url.textContent = ''; }

    if (viewMode === 'tiles') {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.appendChild(fav);
      meta.appendChild(title);
      meta.appendChild(url);
      div.appendChild(meta);
    } else if (viewMode === 'preview') {
      // Big thumbnail on the left, text stacked on the right.
      const body = document.createElement('div');
      body.className = 'pbody';
      const top = document.createElement('div');
      top.className = 'prow-top';
      top.appendChild(fav);
      top.appendChild(title);
      if (item.active) top.appendChild(currentBadge());
      body.appendChild(top);
      body.appendChild(url);
      div.appendChild(body);
      div.appendChild(pin);
    } else {
      div.appendChild(fav);
      div.appendChild(title);
      if (item.active) div.appendChild(currentBadge());
      div.appendChild(url);
      div.appendChild(pin);
    }

    div.addEventListener('click', function() {
      selectedIndex = index;
      selectCurrent();
    });

    list.appendChild(div);
  });
  const sel = list.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function selectCurrent() {
  const item = filteredTabs[selectedIndex];
  if (!item) {
    closeWindow();
    return;
  }
  chrome.runtime.sendMessage({ type: 'switch-tab', tabId: item.id, windowId: item.windowId });
}

function closeWindow() {
  chrome.windows.getCurrent(function(win) {
    chrome.windows.remove(win.id);
  });
}
