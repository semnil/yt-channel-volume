// background.js — YT Channel Volume service worker
// The single writer for channelVolumes and the settings. Every tab and the
// options page send their saves here, so two documents cannot read the channel
// map and then write it back over each other's entry, and a settings save is
// queued with the move of the settings to sync.

importScripts('core/common.js', 'utils.js');

// Every start, so a move that failed is tried again; once local no longer holds
// the settings this is one read. It is queued with the settings saves, so a save
// cannot land inside it. Options also offers its controls only once the fold
// has answered, and the fold answers once the move has settled.
const settingsMoved = queueSettingsWrite(moveSettingsToSync)
  .catch(err => console.error('[YTCV] settings not moved to sync', err));

const CHANNEL_WRITE_PREFIX = 'store:';

// A refusal is answered as invalid-mutation, a storage failure by the table it
// came from.
chrome.runtime.onMessage.addListener(createWriteListener({
  prefix: '[YTCV]',
  route: (msg) => {
    const channelWrite = tableWrite(CHANNEL_WRITES, CHANNEL_WRITE_PREFIX, msg?.type);
    if (channelWrite) {
      return {
        write: msg.type === CHANNEL_WRITE_PREFIX + 'migrateLegacyGains'
          ? (m) => settingsMoved.then(() => channelWrite(m))
          : channelWrite,
        label: msg.type,
        failed: 'storage-update-failed'
      };
    }
    const settingsWrite = tableWrite(SETTINGS_WRITES, CHANNEL_WRITE_PREFIX, msg?.type);
    return settingsWrite ? { write: settingsWrite, label: msg.type, failed: 'settings-update-failed' } : null;
  }
}));
