// Studio Pro (docs/shell.md): a one-line subtitle under each screen's title, and the menu buttons named for screen
// readers and tooltips when the menu shows icons only. Texts come from the string table (strings/nav.js).
import { t } from './i18n.js';

const SCREENS = ['today', 'projects', 'roster', 'feed', 'timeline', 'settings'];

function enhance() {
  for (const key of SCREENS) {
    const panel = document.querySelector(`#tab-${key}`);
    if (!panel || panel.querySelector('.screen-subtitle')) continue;
    const head = panel.querySelector('.screen-head') || panel.querySelector('.screen-title');
    if (!head) continue;
    const line = document.createElement('p');
    line.className = 'screen-subtitle';
    line.textContent = t(`screenSub_${key}`);
    head.after(line);
  }
  for (const button of document.querySelectorAll('.side button')) {
    const label = button.querySelector('[data-i18n]')?.textContent?.trim();
    if (label && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
    if (label && !button.hasAttribute('title')) button.title = label;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhance, { once: true });
else enhance();
