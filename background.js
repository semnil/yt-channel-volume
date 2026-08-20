// background.js — YT Channel Volume service worker
// The single writer for channelVolumes. Every tab and the options page send
// their saves here, so two documents cannot read the channel map and then
// write it back over each other's entry.

importScripts('utils.js');

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
    .then(() => write(msg))
    .then(() => sendResponse({ ok: true }))
    .catch(err => {
      console.error('[YTCV] ' + msg.type + ' failed', err);
      sendResponse({ ok: false, reason: 'storage write failed' });
    });
  return true;
});
