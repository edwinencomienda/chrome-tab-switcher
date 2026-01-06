let allTabs = [];
let filteredTabs = [];
let selectedIndex = 0;
let currentWindowId;
let currentTabId;

document.addEventListener('DOMContentLoaded', function() {
  loadTabs();

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
    // Sort by most recently accessed
    allTabs.sort(function(a, b) {
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
    let classes = 'tab-item';
    if (index === selectedIndex) classes += ' selected';
    if (item.tab.id === currentTabId) classes += ' active';
    div.className = classes;
    let favicon = item.tab.favIconUrl ? '<img src="' + item.tab.favIconUrl + '" alt="" style="width:16px;height:16px;margin-right:8px;flex-shrink:0;">' : '<div style="width:16px;height:16px;margin-right:8px;flex-shrink:0;background:#ccc;border-radius:2px;"></div>';
    div.innerHTML = favicon + '<span class="tab-title">' + item.tab.title + '</span>';
    div.onclick = function() { select(index); };
    list.appendChild(div);
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
