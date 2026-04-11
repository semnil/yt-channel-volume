// background.js — YT Channel Volume service worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'stateChanged') {
    // Content script notifying about state change; relay to popup if open
    return;
  }
});
