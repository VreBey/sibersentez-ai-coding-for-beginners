# Browser extension starter: reference

Contents: extension/manifest.json · extension/content.js · extension/popup.html · extension/popup.js · Common problems
· Good habits

Checked against Chrome's extension documentation (https://developer.chrome.com/docs/extensions) on 2026-10-01; revisit
every six months. Firefox accepts most of the same code but differs in details (its own `browser_specific_settings`
and background setup): read its documentation before promising a Firefox version.

## extension/manifest.json

```json
{
  "manifest_version": 3,
  "name": "Link opener",
  "version": "0.1.0",
  "description": "Opens links on example.com in a new tab.",
  "permissions": ["storage"],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Link opener"
  },
  "content_scripts": [
    {
      "matches": ["https://example.com/*"],
      "js": ["content.js"]
    }
  ]
}
```

Change `matches` to the user's site. `storage` is only there for the popup's saved setting; remove it if unused.
JSON has no comments and no trailing commas.

## extension/content.js

```js
// Runs inside pages that match the manifest. It sees the page but lives in its own world:
// the page's own variables are not visible here.
chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  if (!enabled) return;
  for (const link of document.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
});
```

Use `textContent` to put text into the page, never `innerHTML` with text that came from a page or a user.

## extension/popup.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Link opener</title>
    <style>body { width: 220px; padding: 12px; font: 14px system-ui, sans-serif; }</style>
  </head>
  <body>
    <label><input type="checkbox" id="enabled"> Open links in a new tab</label>
    <script src="popup.js"></script>
  </body>
</html>
```

Manifest V3 pages cannot hold inline `<script>` code: the script is a separate file.

## extension/popup.js

```js
const box = document.getElementById('enabled');

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  box.checked = enabled;
});

box.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: box.checked });
});
```

The setting applies the next time a page loads. To change an open page at once, the popup would send a message to
the content script (`chrome.tabs.sendMessage`, which needs `activeTab` or a matching host); add that only when the
user asks for it.

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| "Manifest file is missing or unreadable" | the folder chosen is not the one holding `manifest.json`, or the JSON has a comma or quote mistake. |
| "Invalid value for 'content_scripts[0].matches'" | the pattern needs a scheme, host and path: `https://example.com/*`. |
| The content script never runs | the page URL does not match the pattern; the page was open before loading the extension (reload it); the page is a browser page such as `chrome://`, which extensions cannot touch. |
| Edits do not show | press the reload arrow on the extension card, then reload the page. |
| `Cannot read properties of undefined (reading 'local')` | the `storage` permission is missing in the manifest. |
| "Refused to execute inline script because it violates the Content Security Policy" | inline code or `onclick="..."` in the popup. Move it to a `.js` file and use `addEventListener`. |
| "Could not establish connection. Receiving end does not exist." | a message was sent to a page whose content script is not loaded yet (reload the page), or to the wrong tab. |
| "Service worker registration failed" | a syntax error in the background file, or its path in the manifest is wrong. |
| The popup is blank | open it with Inspect: the first red line names the file. Often a wrong file name in `popup.html`. |
| The store review rejects it | permissions it does not use, code loaded from outside the package, or a description that does not say what the extension does. |

## Good habits

- Version number goes up in `manifest.json` every time a copy is shared.
- Keep a short list of what each permission is for in the README: reviewers and users ask.
- Do not collect or send page content anywhere. If the idea needs a server, discuss privacy first.
- Test on a throwaway browser profile when the extension touches many sites.
