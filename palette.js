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
    filterTabs();
    render();
  });

  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('keyup', handleKeyup, true);

  // Previews for other windows arrive shortly after the palette opens.
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'session' || !changes.tabPreviews) return;
      if (viewMode !== 'tiles') return;
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

// Never let a settings/preview read block the tab list: it renders on its own,
// then re-renders if a view mode or previews arrive.
function loadViewSettings() {
  safeStorageGet('local', { viewMode: 'tiles', pinnedUrls: [] }, function(settings) {
    viewMode = settings.viewMode === 'tiles' ? 'tiles' : 'list';
    pinnedUrls = Array.isArray(settings.pinnedUrls) ? settings.pinnedUrls : [];
    // Pins can land after the tabs did, which re-sorts the list under the
    // selection — re-anchor it on the tab it was already pointing at.
    if (tabsLoaded) {
      const selected = filteredTabs[selectedIndex];
      applyOrder(selected && selected.id);
      if (!selected) selectedIndex = initialSelection();
    }
    render();
    if (viewMode !== 'tiles') return;
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

// Tile view is a real grid, so up/down should move a whole row.
function columnCount() {
  if (viewMode !== 'tiles') return 1;
  const list = document.getElementById('list');
  const columns = getComputedStyle(list).gridTemplateColumns;
  const count = columns && columns !== 'none' ? columns.split(' ').length : 1;
  return Math.max(1, count);
}

function moveByRow(delta) {
  if (filteredTabs.length === 0) return;
  const columns = columnCount();
  const target = selectedIndex + delta * columns;
  if (target < 0) {
    // Already on the top row: step to the first tab rather than doing nothing.
    selectedIndex = 0;
  } else if (target >= filteredTabs.length) {
    selectedIndex = filteredTabs.length - 1;
  } else {
    selectedIndex = target;
  }
  updateSelection(true);
}

// Left/right drive the grid, but not while the caret still has somewhere to go
// inside a typed query — editing the search text wins there.
function caretCanMove(direction) {
  const search = document.getElementById('search');
  if (!search || document.activeElement !== search) return false;
  const value = search.value || '';
  if (!value) return false;
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
    if (grid) moveByRow(1); else cycleNext();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    cycleCount = 0;
    if (grid) moveByRow(-1); else cyclePrev();
    e.preventDefault();
  } else if (e.key === 'ArrowRight' && grid && (forceNav || !caretCanMove(1))) {
    cycleCount = 0;
    cycleNext();
    e.preventDefault();
  } else if (e.key === 'ArrowLeft' && grid && (forceNav || !caretCanMove(-1))) {
    cycleCount = 0;
    cyclePrev();
    e.preventDefault();
  } else if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
    const item = filteredTabs[selectedIndex];
    if (item) togglePin(item);
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
  if (filteredTabs.length === 0) return;
  selectedIndex = (selectedIndex + 1) % filteredTabs.length;
  updateSelection(true);
}

function cyclePrev() {
  if (filteredTabs.length === 0) return;
  selectedIndex = (selectedIndex - 1 + filteredTabs.length) % filteredTabs.length;
  updateSelection(true);
}

// Move the highlight without rebuilding the list — a full render would reload
// every preview image and flicker.
function updateSelection(scroll) {
  const items = document.getElementById('list').children;
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
  if (selectedIndex >= filteredTabs.length) selectedIndex = 0;
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
  list.className = viewMode === 'tiles' ? 'tiles' : '';
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
