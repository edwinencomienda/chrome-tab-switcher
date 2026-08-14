let paletteWindowId = null;
let paletteTabId = null;
let switching = false;
const MAX_PREVIEWS = 20;
// captureVisibleTab is rate limited when called without a user gesture.
const CAPTURE_SPACING_MS = 600;
let captureTimer = null;

// Capturing a tab needs either the gesture-scoped activeTab grant (opener tab
// only) or the optional <all_urls> host permission (any tab, so tiles can fill
// in as you browse). The popup asks for it when tile view is enabled.
function hasBroadCapture(callback) {
  if (!chrome.permissions) {
    callback(false);
    return;
  }
  chrome.permissions.contains({ origins: ['<all_urls>'] }, function(granted) {
    callback(!chrome.runtime.lastError && !!granted);
  });
}

// Previews cost a screenshot per tab change, so only take them when tile view
// is actually selected and we're allowed to capture any tab.
function previewsEnabled(callback) {
  chrome.storage.local.get({ viewMode: 'tiles' }, function(settings) {
    if (chrome.runtime.lastError || !settings || settings.viewMode !== 'tiles') {
      callback(false);
      return;
    }
    hasBroadCapture(callback);
  });
}

function cacheActiveTabPreview(windowId, tabId, done) {
  if (typeof windowId !== 'number' || tabId < 0) {
    done();
    return;
  }
  let capturing = false;
  try {
    capturing = true;
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 35 }, onCaptured);
  } catch (_) {
    capturing = false;
  }
  if (!capturing) done();

  function onCaptured(dataUrl) {
    if (chrome.runtime.lastError || !dataUrl) {
      done();
      return;
    }
    chrome.storage.session.get({ tabPreviews: {} }, function(result) {
      const previews = result.tabPreviews || {};
      previews[tabId] = { dataUrl: dataUrl, capturedAt: Date.now() };
      const trimmed = Object.entries(previews)
        .sort(function(a, b) { return b[1].capturedAt - a[1].capturedAt; })
        .slice(0, MAX_PREVIEWS)
        .reduce(function(items, entry) {
          items[entry[0]] = entry[1];
          return items;
        }, {});
      chrome.storage.session.set({ tabPreviews: trimmed }, done);
    });
  }
}

// Keep previews fresh as the user browses, so tile view has something to show
// for tabs other than the one the switcher was opened from.
function captureCurrentTabSoon() {
  if (captureTimer !== null) clearTimeout(captureTimer);
  captureTimer = setTimeout(function() {
    captureTimer = null;
    hasBroadCapture(function(granted) {
      if (!granted) return;
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function(tabs) {
        const tab = tabs && tabs[0];
        if (!tab || tab.windowId === paletteWindowId) return;
        cacheActiveTabPreview(tab.windowId, tab.id, function() {});
      });
    });
  }, CAPTURE_SPACING_MS);
}

// Capture the visible tab of each other window, spaced out to stay under the
// capture rate limit.
function captureOtherWindows(skipWindowId) {
  previewsEnabled(function(enabled) {
    if (!enabled) return;
    chrome.windows.getAll({ populate: true }, function(windows) {
      const targets = [];
      (windows || []).forEach(function(win) {
        if (win.id === skipWindowId || win.id === paletteWindowId) return;
        // The palette is a popup window and may not be registered yet.
        if (win.type && win.type !== 'normal') return;
        (win.tabs || []).forEach(function(tab) {
          if (tab.active) targets.push({ windowId: win.id, tabId: tab.id });
        });
      });
      (function next(i) {
        if (i >= targets.length) return;
        cacheActiveTabPreview(targets[i].windowId, targets[i].tabId, function() {
          setTimeout(function() { next(i + 1); }, CAPTURE_SPACING_MS);
        });
      })(0);
    });
  });
}

chrome.tabs.onActivated.addListener(captureCurrentTabSoon);
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab && tab.active) captureCurrentTabSoon();
});

chrome.windows.onRemoved.addListener(function(windowId) {
  if (windowId === paletteWindowId) {
    paletteWindowId = null;
    paletteTabId = null;
  }
});

chrome.tabs.onRemoved.addListener(function(tabId) {
  chrome.storage.session.get({ tabPreviews: {} }, function(result) {
    const previews = result.tabPreviews || {};
    if (!previews[tabId]) return;
    delete previews[tabId];
    chrome.storage.session.set({ tabPreviews: previews });
  });
});

chrome.windows.onFocusChanged.addListener(function(windowId) {
  if (switching) return;
  if (paletteWindowId === null) return;
  if (windowId === paletteWindowId) return;
  const idToClose = paletteWindowId;
  paletteWindowId = null;
  paletteTabId = null;
  chrome.windows.remove(idToClose, function() { void chrome.runtime.lastError; });
});

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'switch-tab') {
    switching = true;
    chrome.tabs.update(msg.tabId, { active: true }, function() {
      chrome.windows.update(msg.windowId, { focused: true }, function() {
        const id = paletteWindowId;
        paletteWindowId = null;
        paletteTabId = null;
        if (id !== null) {
          chrome.windows.remove(id, function() {
            void chrome.runtime.lastError;
            switching = false;
          });
        } else {
          switching = false;
        }
      });
    });
  }
});

chrome.commands.onCommand.addListener(function(command) {
  if (command !== 'open-and-cycle') return;

  if (paletteWindowId !== null) {
    chrome.windows.update(paletteWindowId, { focused: true }, function() {
      if (chrome.runtime.lastError) {
        paletteWindowId = null;
        paletteTabId = null;
        openPaletteWindow();
        return;
      }
      chrome.runtime.sendMessage({ type: 'cycle' }, function() { void chrome.runtime.lastError; });
    });
    return;
  }

  openPaletteWindow();
});

function openPaletteWindow() {
  chrome.tabs.query({ active: true, currentWindow: true }, function(activeTabs) {
    const openerTabId = activeTabs[0] ? activeTabs[0].id : -1;
    const openerWindowId = activeTabs[0] ? activeTabs[0].windowId : null;
    chrome.storage.local.get({ viewMode: 'tiles' }, function(settings) {
      if (chrome.runtime.lastError || !settings || settings.viewMode !== 'tiles') {
        createPaletteWindow(openerTabId);
        return;
      }
      // The activeTab grant from the command covers the opener tab, so this
      // capture works with no extra permission.
      cacheActiveTabPreview(openerWindowId, openerTabId, function() {
        createPaletteWindow(openerTabId);
        captureOtherWindows(openerWindowId);
      });
    });
  });
}

function createPaletteWindow(openerTabId) {
  const url = chrome.runtime.getURL('palette.html') + '?opener=' + encodeURIComponent(openerTabId);
  const w = 640;
  const h = 520;

  chrome.windows.getLastFocused({ populate: false }, function(parent) {
    let left, top;
    if (parent && typeof parent.left === 'number') {
      left = Math.round(parent.left + (parent.width - w) / 2);
      top = Math.round(parent.top + (parent.height - h) / 2);
    }
    const opts = { url: url, type: 'popup', width: w, height: h, focused: true };
    if (typeof left === 'number') opts.left = left;
    if (typeof top === 'number') opts.top = top;

    chrome.windows.create(opts, function(win) {
      if (!win) return;
      paletteWindowId = win.id;
      paletteTabId = win.tabs && win.tabs[0] && win.tabs[0].id;
    });
  });
}
