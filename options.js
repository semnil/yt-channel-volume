// options.js — YT Channel Volume settings page

(() => {
  'use strict';

  // Apply data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = msg(el.dataset.i18n);
  });

  const targetSlider = document.getElementById('targetSlider');
  const targetValueEl = document.getElementById('targetValue');
  const unitToggle = document.getElementById('unitToggle');
  const overlayToggle = document.getElementById('overlayToggle');
  const channelListEl = document.getElementById('channelList');

  let displayUnit = '%';
  let targetLufs = DEFAULT_TARGET_LUFS;

  function fmtGain(gain) {
    const f = formatGain(gain, displayUnit);
    return f.text + f.unit;
  }

  // ── Settings ───────────────────────────────────────────────────────

  async function loadSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    displayUnit = s.displayUnit || '%';
    overlayToggle.checked = !!s.showGainOverlay;
    targetSlider.value = targetLufs;
    targetValueEl.textContent = targetLufs + ' LUFS';
    updateUnitButtons();
  }

  async function saveSetting(key, value) {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    s[key] = value;
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }

  function updateUnitButtons() {
    unitToggle.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === displayUnit);
    });
  }

  // ── Channel list ───────────────────────────────────────────────────

  async function renderChannels() {
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entries = Object.entries(all);

    if (entries.length === 0) {
      channelListEl.innerHTML = '<div class="empty-msg">' + esc(msg('noSavedChannels')) + '</div>';
      return;
    }

    entries.sort((a, b) => a[1].name.localeCompare(b[1].name));

    const table = document.createElement('table');
    table.className = 'channel-table';
    table.innerHTML = `<thead><tr>
      <th>${esc(msg('colChannel'))}</th>
      <th style="text-align:right">${esc(msg('typeVideo'))}</th>
      <th style="text-align:right">${esc(msg('typeLive'))}</th>
      <th></th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const [id, entry] of entries) {
      const { name, url } = entry;
      // Support old format (single gain) and new format (gainLive/gainVideo)
      const gainLive = entry.gainLive ?? entry.gain ?? null;
      const gainVideo = entry.gainVideo ?? entry.gain ?? null;
      const tr = document.createElement('tr');
      const nameHtml = url
        ? `<a class="ch-link" href="${esc(url)}" target="_blank">${esc(name)}</a>`
        : esc(name);
      tr.innerHTML = `
        <td class="ch-name">${nameHtml}</td>
        <td class="ch-vol">${gainVideo !== null ? fmtGain(gainVideo) : '—'}</td>
        <td class="ch-vol">${gainLive !== null ? fmtGain(gainLive) : '—'}</td>
        <td style="text-align:right"><button class="ch-del" data-id="${esc(id)}" title="${esc(msg('delete'))}">×</button></td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    channelListEl.innerHTML = '';
    channelListEl.appendChild(table);

    channelListEl.querySelectorAll('.ch-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const d = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
        const obj = d[CHANNEL_VOLUMES_KEY] || {};
        delete obj[id];
        await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: obj });
        renderChannels();
      });
    });
  }

  // ── Events ─────────────────────────────────────────────────────────

  targetSlider.addEventListener('input', () => {
    targetValueEl.textContent = targetSlider.value + ' LUFS';
  });

  targetSlider.addEventListener('change', () => {
    targetLufs = Number(targetSlider.value);
    saveSetting('targetLufs', targetLufs);
  });

  overlayToggle.addEventListener('change', () => {
    saveSetting('showGainOverlay', overlayToggle.checked);
  });

  unitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.unit) return;
    displayUnit = btn.dataset.unit;
    updateUnitButtons();
    saveSetting('displayUnit', displayUnit);
    renderChannels();
  });

  // ── Storage change listener ─────────────────────────────────────
  // Re-render when storage changes from popup or content script

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CHANNEL_VOLUMES_KEY]) {
      renderChannels();
    }
    if (changes[SETTINGS_KEY]) {
      const s = changes[SETTINGS_KEY].newValue || {};
      if (s.targetLufs !== undefined && s.targetLufs !== targetLufs) {
        targetLufs = s.targetLufs;
        targetSlider.value = targetLufs;
        targetValueEl.textContent = targetLufs + ' LUFS';
      }
      if (s.displayUnit && s.displayUnit !== displayUnit) {
        displayUnit = s.displayUnit;
        updateUnitButtons();
        renderChannels();
      }
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  loadSettings().then(() => {
    renderChannels();
  });
})();
