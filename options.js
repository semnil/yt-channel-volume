// options.js — YT Channel Volume settings page

(() => {
  'use strict';

  applyI18n();

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
  // Until the fold lands, the table has to read the map the way the content
  // script does, or it shows Auto for channels that are still manual.
  let storageMigrated = false;
  // Deleting is offered once the load has read what it would delete from.
  let settingsLoaded = false;
  // A load that did not arrive leaves the page saying so, and keeping it so.
  let loadFailed = false;
  // What a change notification has already put on the page. The initial read is
  // issued before them and can return older values, so it applies what it read
  // only where no notification has arrived since it was issued.
  let settingsRevision = 0;
  let channelRevision = 0;
  let channelVolumes = null;

  function fmtGain(gain) {
    const f = formatGain(gain, displayUnit);
    return f.text + f.unit;
  }

  // ── Settings ───────────────────────────────────────────────────────

  function setSettingsControlsDisabled(disabled) {
    for (const control of [
      targetSlider, defaultAutoVideoToggle, defaultAutoLiveToggle, overlayToggle, clearAllBtn
    ]) {
      control.disabled = disabled;
    }
    unitToggle.querySelectorAll('button').forEach(btn => { btn.disabled = disabled; });
  }

  // The settings (sync) and the channels (local) are read as one load, so a
  // page that shows what it read shows both or neither, and the line it puts up
  // when it fails names that one load.
  async function loadAll() {
    const settingsAt = settingsRevision;
    const channelsAt = channelRevision;
    const [settings, data] = await Promise.all([
      readSettings(),
      chrome.storage.local.get(CHANNEL_VOLUMES_KEY)
    ]);
    // The page has already been shown as one whose load did not arrive, so what
    // arrives afterwards does not get to fill it in behind that.
    if (loadFailed) return;
    if (settingsAt === settingsRevision) applySettings(settings);
    settingsLoaded = true;
    if (channelsAt === channelRevision) channelVolumes = data[CHANNEL_VOLUMES_KEY] || {};
    renderChannels(channelVolumes);
  }

  function applySettings(s) {
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    displayUnit = s.displayUnit || '%';
    defaultAutoApplyVideo =
      s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLive =
      s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoVideoToggle.checked = defaultAutoApplyVideo;
    defaultAutoLiveToggle.checked = defaultAutoApplyLive;
    overlayToggle.checked = s.showGainOverlay ?? true;
    if (!targetHeld()) drawTarget();
    updateUnitButtons();
  }

  // A key or the pointer held on the Target LUFS slider keeps the slider and
  // its label on the value the gesture moved to; applySettings takes the
  // target all the same, and the gesture's end writes its own value, or draws
  // the target where it writes nothing (a key that moved nothing, a drag let
  // go of where it began, a press a blur ended).
  function drawTarget() {
    targetSlider.value = targetLufs;
    targetValueEl.textContent = targetLufs + ' LUFS';
  }

  async function saveSetting(key, value) {
    // A page that never read the settings does not get to write one back.
    if (!settingsLoaded) return;
    // The worker writes it, queued with its move of the settings to sync, so a
    // save made while a move is out is not put back by it.
    await requestChannelWrite('saveSetting', { key, value });
  }

  // A write that did not land leaves the control showing a value nothing holds,
  // so the page goes back to what storage holds and says that it did
  // (saveSettingOrRestore in core/common.js). Answers whether the write landed.
  function saveField(key, value) {
    return saveSettingOrRestore(() => saveSetting(key, value), {
      loaded: () => settingsLoaded,
      read: () => readSettings(),
      // The table is drawn again only where the unit moved, so a control of
      // the table the viewer is on keeps its focus.
      apply: (settings) => {
        const unitBefore = displayUnit;
        applySettings(settings);
        if (displayUnit !== unitBefore) renderChannels(channelVolumes);
      },
      revision: () => settingsRevision,
      prefix: '[YTCV]'
    });
  }

  function updateUnitButtons() {
    unitToggle.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === displayUnit);
    });
  }

  // The service worker performs every channel write; see background.js.
  function requestChannelWrite(type, payload = {}) {
    return requestWrite({ type: 'store:' + type, ...payload });
  }

  function resolveAutoApply(entry, videoType) {
    const defaultValue = videoType === 'live'
      ? defaultAutoApplyLive
      : defaultAutoApplyVideo;
    return resolveAutoApplySetting(entry, videoType, defaultValue, !storageMigrated);
  }

  // ── Channel list ───────────────────────────────────────────────────

  // Draws the list the page holds, and nothing else. A read of its own would be
  // a second read racing the one that is already out, and it would land without
  // anything to weigh it against; a page that holds no list yet draws none.
  function renderChannels(all) {
    if (!all) return;
    const entries = Object.entries(all);

    if (entries.length === 0) {
      channelListEl.innerHTML = '<div class="empty-msg">' + esc(msg('noSavedChannels')) + '</div>';
      return;
    }

    entries.sort((a, b) => rowLabel(a[0], a[1]).localeCompare(rowLabel(b[0], b[1])));

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
      const name = rowLabel(id, entry);
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
        <td style="text-align:right"><button class="ch-del" data-id="${esc(id)}"${settingsLoaded ? '' : ' disabled'} title="${esc(msg('delete'))}">×</button></td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    channelListEl.innerHTML = '';
    channelListEl.appendChild(table);

    channelListEl.querySelectorAll('.ch-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!settingsLoaded) return;
        const id = btn.dataset.id;
        try {
          await requestChannelWrite('deleteChannel', { channelId: id });
        } catch (err) {
          console.error('[YTCV] channel not deleted', err);
          alert(msg('channelUpdateFailed'));
        }
        // The worker's write comes back as a change notification, which carries
        // the list the table is redrawn from.
      });
    });
  }

  // ── Events ─────────────────────────────────────────────────────────

  // One write per gesture on the Target LUFS slider (holdSettingsSlider in
  // core/common.js), against the target the page holds.
  const targetHeld = holdSettingsSlider(targetSlider, {
    current: () => targetLufs,
    drawLabel: (value) => { targetValueEl.textContent = value + ' LUFS'; },
    save: (value) => {
      targetLufs = value;
      saveField('targetLufs', value);
    }
  });

  // A default is taken out of use while its save is out, and the table follows
  // it once the save lands. A save that does not land puts the toggle back to
  // what the settings hold and says so.
  for (const [toggle, field, take] of [
    [defaultAutoVideoToggle, 'autoApplyLoudnessVideoDefault', (enabled) => { defaultAutoApplyVideo = enabled; }],
    [defaultAutoLiveToggle, 'autoApplyLoudnessLiveDefault', (enabled) => { defaultAutoApplyLive = enabled; }]
  ]) {
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      toggle.disabled = true;
      try {
        if (await saveField(field, enabled)) {
          take(enabled);
          renderChannels(channelVolumes);
        }
      } finally {
        toggle.disabled = false;
      }
    });
  }

  overlayToggle.addEventListener('change', () => {
    saveField('showGainOverlay', overlayToggle.checked);
  });

  clearAllBtn.addEventListener('click', async () => {
    if (!confirm(msg('clearAllConfirm'))) return;
    try {
      await requestChannelWrite('clearChannels');
    } catch (err) {
      console.error('[YTCV] channels not cleared', err);
      alert(msg('channelUpdateFailed'));
    }
  });

  unitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.unit) return;
    // The unit already in use is not written again.
    if (btn.dataset.unit === displayUnit) return;
    displayUnit = btn.dataset.unit;
    updateUnitButtons();
    renderChannels(channelVolumes);
    saveField('displayUnit', displayUnit);
  });

  // ── Storage change listener ─────────────────────────────────────
  // Re-render when storage changes from popup or content script

  chrome.storage.onChanged.addListener((changes, area) => {
    // The page that could not read its own settings is telling the viewer to
    // reload it. What another tab writes after that would stand on a page whose
    // own read never landed, so none of it is taken.
    if (loadFailed) return;
    // The settings live in sync, and so do the ones another Chrome the user is
    // signed in to writes with Chrome sync on. The settings key in local is only
    // the copy the worker moves out of it.
    if (area === 'sync') {
      if (changes[SETTINGS_KEY]) {
        settingsRevision++;
        applySettings(changes[SETTINGS_KEY].newValue || {});
        renderChannels(channelVolumes);
      }
      return;
    }
    if (area !== 'local') return;
    // Another context may have folded the profile; the table has to stop
    // reading the map under the pre-unification rule.
    if (changes[UNIFIED_GAINS_KEY]?.newValue === true && !storageMigrated) {
      storageMigrated = true;
      renderChannels(channelVolumes);
    }
    // The notification carries the map itself, so it is what the page holds and
    // what the table draws; nothing is read back for it.
    if (changes[CHANNEL_VOLUMES_KEY]) {
      channelRevision++;
      channelVolumes = changes[CHANNEL_VOLUMES_KEY].newValue || {};
      renderChannels(channelVolumes);
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  // A load that never settles would leave the page hidden for good, so the wait
  // has an end (runPageLoad's) and it ends the same way a failure does.
  runPageLoad(() => requestChannelWrite('migrateLegacyGains')
    .then(() => { storageMigrated = true; })
    // The table below reads channelVolumes either way; an un-folded profile
    // shows `Auto (—)` for the types whose gain is still in a legacy key.
    .catch(err => console.error('[YTCV] legacy auto gains not folded in', err))
    .then(loadAll), {
    // Everything that acts on what was read is offered once it has been read; a
    // load that never got there leaves them as the markup ships them.
    onLoaded() { setSettingsControlsDisabled(false); },
    onFailed(err) {
      // The page is shown either way; what it says about itself is the part
      // that changes, and the controls stay as the markup ships them.
      loadFailed = true;
      showSettingsError(true, 'settingsLoadFailed');
      console.error('[YTCV] settings not loaded', err);
    }
  });
})();
