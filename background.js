// background.js — YT Channel Volume service worker
// The single writer for channelVolumes. Every tab and the options page send
// their saves here, so two documents cannot read the channel map and then
// write it back over each other's entry.

importScripts('utils.js');

// Every start, so a move that failed is tried again; once local no longer holds
// the settings this is one read. The move reads sync before it writes it, so a
// settings save landing in between would be put back to local's older copy.
// Options writes the settings itself, and offers its controls only once the
// fold has answered; the fold answers once the move has settled, so no save
// can land inside it.
const settingsMoved = moveSettingsToSync()
  .catch(err => console.error('[YTCV] settings not moved to sync', err));

const CHANNEL_WRITE_PREFIX = 'store:';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = typeof msg?.type === 'string' && msg.type.startsWith(CHANNEL_WRITE_PREFIX)
    ? msg.type.slice(CHANNEL_WRITE_PREFIX.length)
    : '';
  const write = Object.prototype.hasOwnProperty.call(CHANNEL_WRITES, type)
    ? CHANNEL_WRITES[type]
    : null;
  // Everything else on this channel belongs to the popup (stateChanged).
  if (!write) return false;
  Promise.resolve()
    .then(() => (type === 'migrateLegacyGains' ? settingsMoved : undefined))
    .then(() => write(msg))
    .then(() => sendResponse({ ok: true }))
    .catch(err => {
      console.error('[YTCV] ' + msg.type + ' failed', err);
      sendResponse({
        ok: false,
        reason: err instanceof ChannelWriteRefused ? 'write refused' : 'storage write failed'
      });
    });
  return true;
});
