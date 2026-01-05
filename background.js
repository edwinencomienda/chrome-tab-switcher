let lastTabId = null;
let currentTabId = null;

chrome.tabs.onActivated.addListener(function(activeInfo) {
  lastTabId = currentTabId;
  currentTabId = activeInfo.tabId;
});

chrome.commands.onCommand.addListener(function(command) {
  if (command === "toggle-last-tab") {
    if (lastTabId !== null) {
      chrome.tabs.get(lastTabId, function(lastTab) {
        if (chrome.runtime.lastError) {
          lastTabId = null;
          return;
        }
        if (lastTab.windowId === currentTabId && currentTabId) {
          chrome.tabs.update(lastTabId, {active: true});
        } else if (currentTabId) {
          chrome.tabs.get(currentTabId, function(currentTab) {
            if (chrome.runtime.lastError) return;
            if (lastTab.windowId === currentTab.windowId) {
              chrome.tabs.update(lastTabId, {active: true});
            } else {
              chrome.windows.update(lastTab.windowId, {focused: true}, function() {
                chrome.tabs.update(lastTabId, {active: true});
              });
            }
          });
        }
      });
    }
  }
});