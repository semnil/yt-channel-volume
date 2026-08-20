// options.js — YT Channel Volume settings page

(() => {
  'use strict';

  // Apply data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = msg(el.dataset.i18n);
  });

  const targetSlider = document.getElementById('targetSlider');
  const targetValueEl = document.getElementById('targetValue');
  const defaultAutoVideoToggle = document.getElementById('defaultAutoVideoToggle');
  const defaultAutoLiveToggle = document.getElementById('defaultAutoLiveToggle');
  const unitToggle = document.getElementById('unitToggle');
  const overlayToggle = document.getElementById('overlayToggle');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const channelListEl = document.getElementById('channelList');

  let displayUnit = '%';
  let targetLufs = DEFAULT_TARGET_LUFS;
  let defaultAutoApplyVideo = DEFAULT_AUTO_APPLY_LOUDNESS;
  let defaultAutoApplyLive = DEFAULT_AUTO_APPLY_LOUDNESS;

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
    defaultAutoApplyVideo =
      s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLive =
      s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoVideoToggle.checked = defaultAutoApplyVideo;
    defaultAutoLiveToggle.checked = defaultAutoApplyLive;
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

  function resolveAutoApply(entry, videoType) {
    const defaultValue = videoType === 'live'
      ? defaultAutoApplyLive
      : defaultAutoApplyVideo;
    return resolveAutoApplySetting(entry, videoType, defaultValue);
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
      const name = entry.name || id;
      const url = entry.url;
      // Support old format (single gain) and new format (gainLive/gainVideo)
      const gainLive = getChannelGain(entry, 'live');
      const gainVideo = getChannelGain(entry, 'video');
      const autoVideo = resolveAutoApply(entry, 'video');
      const autoLive = resolveAutoApply(entry, 'live');
      const videoText = autoVideo
        ? formatAutoGain(gainVideo, displayUnit, msg('labelAuto'))
        : (gainVideo !== null ? fmtGain(gainVideo) : '—');
      const liveText = autoLive
        ? formatAutoGain(gainLive, displayUnit, msg('labelAuto'))
        : (gainLive !== null ? fmtGain(gainLive) : '—');
      const tr = document.createElement('tr');
      const nameHtml = url
        ? `<a class="ch-link" href="${esc(url)}" target="_blank">${esc(name)}</a>`
        : esc(name);
      tr.innerHTML = `
        <td class="ch-name">${nameHtml}</td>
        <td class="ch-vol${autoVideo ? ' auto' : ''}">${esc(videoText)}</td>
        <td class="ch-vol${autoLive ? ' auto' : ''}">${esc(liveText)}</td>
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
        await updateChannelVolumes(all => { delete all[id]; });
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

  defaultAutoVideoToggle.addEventListener('change', async () => {
    const previous = defaultAutoApplyVideo;
    const enabled = defaultAutoVideoToggle.checked;
    defaultAutoVideoToggle.disabled = true;
    try {
      await saveSetting('autoApplyLoudnessVideoDefault', enabled);
      defaultAutoApplyVideo = enabled;
      await renderChannels();
    } catch (_) {
      defaultAutoVideoToggle.checked = previous;
    } finally {
      defaultAutoVideoToggle.disabled = false;
    }
  });

  defaultAutoLiveToggle.addEventListener('change', async () => {
    const previous = defaultAutoApplyLive;
    const enabled = defaultAutoLiveToggle.checked;
    defaultAutoLiveToggle.disabled = true;
    try {
      await saveSetting('autoApplyLoudnessLiveDefault', enabled);
      defaultAutoApplyLive = enabled;
      await renderChannels();
    } catch (_) {
      defaultAutoLiveToggle.checked = previous;
    } finally {
      defaultAutoLiveToggle.disabled = false;
    }
  });

  overlayToggle.addEventListener('change', () => {
    saveSetting('showGainOverlay', overlayToggle.checked);
  });

  clearAllBtn.addEventListener('click', async () => {
    if (!confirm(msg('clearAllConfirm'))) return;
    await updateChannelVolumes(all => {
      for (const id of Object.keys(all)) delete all[id];
    });
    renderChannels();
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
      const nextDefaultVideo =
        s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      const nextDefaultLive =
        s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      if (nextDefaultVideo !== defaultAutoApplyVideo ||
          nextDefaultLive !== defaultAutoApplyLive) {
        defaultAutoApplyVideo = nextDefaultVideo;
        defaultAutoApplyLive = nextDefaultLive;
        defaultAutoVideoToggle.checked = defaultAutoApplyVideo;
        defaultAutoLiveToggle.checked = defaultAutoApplyLive;
        renderChannels();
      }
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  function revealOptions() {
    void document.body.offsetWidth;
    requestAnimationFrame(() => {
      document.body.classList.remove('initializing');
    });
  }

  migrateLegacyAutoGains()
    // The table below reads channelVolumes either way; an un-folded profile
    // shows `Auto (—)` for the types whose gain is still in a legacy key.
    .catch(err => console.error('[YTCV] legacy auto gains not folded in', err))
    .then(loadSettings)
    .then(renderChannels)
    .finally(revealOptions);
})();
