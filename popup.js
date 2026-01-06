let allTabs = [];
let filteredTabs = [];
let selectedIndex = 0;
let currentWindowId;
let currentTabId;
let pinnedTabIds = new Set();
let pinSvg = '';
let pinOffSvg = '';

document.addEventListener('DOMContentLoaded', function() {
  // Pre-load SVGs
  Promise.all([
    fetch('icons/pin.svg').then(r => r.text()),
    fetch('icons/pin-off.svg').then(r => r.text()),
    fetch('icons/arrow-up.svg').then(r => r.text()),
    fetch('icons/arrow-down.svg').then(r => r.text())
  ]).then(([pin, pinOff, arrowUp, arrowDown]) => {
    pinSvg = pin;
    pinOffSvg = pinOff;
    
    // Inject footer icons
    document.getElementById('arrow-up-key').innerHTML = arrowUp;
    document.getElementById('arrow-down-key').innerHTML = arrowDown;
    
    chrome.storage.local.get(['pinnedTabIds'], function(result) {
      if (result.pinnedTabIds) {
        pinnedTabIds = new Set(result.pinnedTabIds);
      }
      loadTabs();
    });
  });

  document.getElementById('search').addEventListener('input', function() {
    filterTabs();
    render();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowDown') {
      selectedIndex = (selectedIndex + 1) % filteredTabs.length;
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      selectedIndex = (selectedIndex - 1 + filteredTabs.length) % filteredTabs.length;
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      select(selectedIndex);
    } else if (e.key === 'Escape') {
      window.close();
    }
  });
});

function loadTabs() {
  chrome.windows.getCurrent(function(currentWin) {
    currentWindowId = currentWin.id;
  });
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (tabs[0]) currentTabId = tabs[0].id;
  });
  chrome.windows.getAll({populate: true}, function(windows) {
    allTabs = [];
    windows.forEach(function(win) {
      win.tabs.forEach(function(tab) {
        allTabs.push({tab: tab, windowId: win.id});
      });
    });
    // Sort: Pinned first, then by most recently accessed
    allTabs.sort(function(a, b) {
      const aPinned = pinnedTabIds.has(a.tab.id);
      const bPinned = pinnedTabIds.has(b.tab.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return b.tab.lastAccessed - a.tab.lastAccessed;
    });
    filterTabs();
    render();
  });
}

function filterTabs() {
  let filter = document.getElementById('search').value.toLowerCase();
  filteredTabs = allTabs.filter(function(item) {
    return item.tab.title.toLowerCase().includes(filter) || item.tab.url.toLowerCase().includes(filter);
  });
  selectedIndex = 0;
}

function render() {
  let list = document.getElementById('list');
  list.innerHTML = '';
  if (filteredTabs.length === 0) {
    list.innerHTML = '<div class="no-results">No tabs found</div>';
    return;
  }
  filteredTabs.forEach(function(item, index) {
    let div = document.createElement('div');
    let isPinned = pinnedTabIds.has(item.tab.id);
    let classes = 'tab-item';
    if (index === selectedIndex) classes += ' selected';
    if (item.tab.id === currentTabId) classes += ' active';
    if (isPinned) classes += ' pinned';
    div.className = classes;
    
    let favicon = item.tab.favIconUrl ? '<img src="' + item.tab.favIconUrl + '" alt="" style="width:16px;height:16px;margin-right:8px;flex-shrink:0;">' : '<div style="width:16px;height:16px;margin-right:8px;flex-shrink:0;background:#ccc;border-radius:2px;"></div>';
    
    let titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = item.tab.title;

    let pinButton = document.createElement('div');
    pinButton.className = 'pin-button';
    pinButton.innerHTML = isPinned ? pinSvg : pinOffSvg;

    pinButton.title = isPinned ? 'Unpin tab' : 'Pin tab to top';
    pinButton.onclick = function(e) {
      e.stopPropagation();
      togglePin(item.tab.id);
    };

    div.innerHTML = favicon;
    div.appendChild(titleSpan);
    div.appendChild(pinButton);
    
    div.onclick = function() { select(index); };
    list.appendChild(div);
  });
}

function togglePin(tabId) {
  if (pinnedTabIds.has(tabId)) {
    pinnedTabIds.delete(tabId);
  } else {
    pinnedTabIds.add(tabId);
  }
  
  chrome.storage.local.set({pinnedTabIds: Array.from(pinnedTabIds)}, function() {
    // Re-sort allTabs based on new pinned status
    allTabs.sort(function(a, b) {
      const aPinned = pinnedTabIds.has(a.tab.id);
      const bPinned = pinnedTabIds.has(b.tab.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return b.tab.lastAccessed - a.tab.lastAccessed;
    });
    filterTabs();
    render();
  });
}

function select(index) {
  let item = filteredTabs[index];
  if (item.windowId === currentWindowId) {
    chrome.tabs.update(item.tab.id, {active: true}, function() {
      window.close();
    });
  } else {
    chrome.windows.update(item.windowId, {focused: true}, function() {
      chrome.tabs.update(item.tab.id, {active: true}, function() {
        window.close();
      });
    });
  }
}
