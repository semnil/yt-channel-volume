# Privacy Policy — YT Channel Volume

[日本語版はこちら (Japanese)](PRIVACY_POLICY_JA.md)

Last updated: 2026-04-11

## Overview

YT Channel Volume is a Chrome extension that remembers and auto-applies volume settings per YouTube channel using Content Loudness data. This privacy policy explains what data the extension handles, how it is used, and where it is stored.

## Data Collected and Purpose

### Channel Volume Settings

- **What**: YouTube channel IDs, display names, channel URLs, and volume (gain) values you set.
- **Purpose**: Used to automatically apply your preferred volume when you visit a video from a saved channel.
- **Storage**: Saved locally in `chrome.storage.local` on your device. Never transmitted to any external server.

### Extension Preferences

- **What**: Target LUFS level, display unit (% or dB), gain overlay toggle.
- **Purpose**: Customize the extension's behavior according to your preferences.
- **Storage**: Saved locally in `chrome.storage.local` on your device.

### YouTube Video Metadata (read-only)

- **What**: Content Loudness (`loudnessDb`), `isLiveContent`, `isLive`, `channelId`, and `videoId` from YouTube's player response.
- **Purpose**: Display loudness information and calculate suggested volume. Determine whether content is a live stream or a regular video.
- **Storage**: Not stored. Values are held in memory only while the video page is open and discarded on navigation.

## Data NOT Collected

- The extension does **not** collect browsing history, analytics, or telemetry.
- The extension does **not** track which pages you visit on YouTube or any other site.
- The extension developer does **not** receive, store, or have access to any of your data.
- No data is sold, shared with third parties, or used for advertising.

## Where Data Is Sent

Nowhere. This extension makes **no external network requests**. All data remains on your device.

## Data Storage and Security

- All settings are stored in `chrome.storage.local`, which is accessible only to this extension.
- No data is synced across devices or stored in the cloud.
- Uninstalling the extension removes all locally stored data.

## Permissions

| Permission | Reason |
|---|---|
| **storage** | Save channel volume settings and user preferences locally |
| **activeTab** | Access the current YouTube tab to detect the channel, read Content Loudness, and apply volume adjustment |
| **host_permissions** (`youtube.com`) | Inject content scripts on YouTube pages to control audio volume via Web Audio API |

## Remote Code

This extension does **not** use remote code. All JavaScript is bundled locally within the extension package. The `page-bridge.js` content script runs in the page's main world (`"world": "MAIN"`) to read YouTube's player response data — this is local code, not remotely fetched.

## Single Purpose

This extension has a single purpose: **adjust and remember volume settings per YouTube channel** using YouTube's Content Loudness metadata and Web Audio API.

## Third-Party Dependencies

None. The extension contains no external libraries, SDKs, CDNs, or analytics tools.

## Changes to This Policy

Updates will be posted to this page with a revised date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, please open an [issue](https://github.com/semnil/yt-channel-volume/issues) on the GitHub repository.
