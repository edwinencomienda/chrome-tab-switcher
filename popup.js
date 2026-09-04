document.addEventListener('DOMContentLoaded', function() {
  const viewOptions = Array.from(document.querySelectorAll('.view-option'));
  const toggle = document.getElementById('view-toggle');
  const hint = document.getElementById('view-hint');
  const PREVIEW_HINT = 'Page previews stay on this device and clear with your browser session.';
  const PREVIEW_DENIED_HINT = 'Without page access, only the tab you opened the switcher from gets a preview.';

  function setActiveView(view) {
    toggle.dataset.view = view;
    document.getElementById('navkeys').dataset.view = view;
    document.body.dataset.view = view;
    viewOptions.forEach(function(option) {
      const isActive = option.dataset.view === view;
      option.classList.toggle('active', isActive);
      option.setAttribute('aria-pressed', String(isActive));
    });
  }

  // Previewing tabs other than the opener needs host access, so ask for it the
  // first time tile view is picked (the click is the required user gesture).
  function ensurePreviewPermission() {
    const request = { origins: ['<all_urls>'] };
    chrome.permissions.contains(request, function(granted) {
      if (granted) return;
      chrome.permissions.request(request, function(accepted) {
        hint.textContent = accepted ? PREVIEW_HINT : PREVIEW_DENIED_HINT;
      });
    });
  }

  chrome.storage.local.get({ viewMode: 'tiles' }, function(settings) {
    const view = settings.viewMode === 'list' || settings.viewMode === 'preview' ? settings.viewMode : 'tiles';
    setActiveView(view);
  });

  viewOptions.forEach(function(option) {
    option.addEventListener('click', function() {
      const view = option.dataset.view;
      chrome.storage.local.set({ viewMode: view });
      setActiveView(view);
      if (view === 'tiles' || view === 'preview') ensurePreviewPermission();
    });
  });

  renderHotkey();
  document.getElementById('pin-key').textContent = keySymbol('command') + 'P';

  function renderHotkey() {
    const el = document.getElementById('hotkey');
    chrome.commands.getAll(function(commands) {
      const cmd = (commands || []).find(function(c) { return c.name === 'open-and-cycle'; });
      el.textContent = '';
      if (!cmd || !cmd.shortcut) {
        el.appendChild(keycap('Not set', true));
        return;
      }
      cmd.shortcut.split('+').forEach(function(part) {
        el.appendChild(keycap(keySymbol(part.trim())));
      });
    });
  }

  function keycap(text, unset) {
    const kbd = document.createElement('kbd');
    if (unset) kbd.className = 'unset';
    kbd.textContent = text;
    return kbd;
  }

  // Show the glyphs the OS itself prints on the keys.
  function keySymbol(part) {
    const mac = navigator.userAgent.includes('Mac');
    const symbols = mac
      ? { command: '⌘', ctrl: '⌃', macctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧' }
      : { command: 'Win', ctrl: 'Ctrl', macctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' };
    const key = part.toLowerCase();
    return symbols[key] || part.toUpperCase();
  }

  document.getElementById('open-shortcuts-page').addEventListener('click', function(e) {
    e.preventDefault();
    if (typeof browser !== 'undefined' && browser.commands.openShortcutSettings) {
      browser.commands.openShortcutSettings();
      return;
    }
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  document.getElementById('reset-position').addEventListener('click', function() {
    chrome.runtime.sendMessage({ type: 'reset-position' });
  });
});
