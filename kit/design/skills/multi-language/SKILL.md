---
name: multi-language
description: "Makes a site or app speak two or more languages: moves every visible text into one file per language, adds a language switch that remembers the choice, sets the page language, formats dates, numbers and money per language, and checks that nothing is left untranslated. Use when a project needs Turkish and English, or another language added."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "web, ui"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "çok dilli, iki dilli, ingilizce ekle*, türkçe ve ingilizce, dil seçimi, dil değiştir*, çeviri ekle*, yabancı dil, i18n"
---

# Multi-language

A second language is mostly bookkeeping: every sentence a person sees must come from one place per language, or some
will be forgotten. Do the bookkeeping first, then translate.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- The user decides the wording. Machine translation is a first draft: say which texts you translated and ask the user
  (or someone who speaks the language) to read them before publishing.

## 1. Decide

Ask: which languages, which one is the main one, and should the address change per language (`/en/...`, good for
search engines and sharing) or only a switch (simpler, fine for an app). Use what the project's framework already has
for languages (Next.js, Vue, Flutter, Unity Localization and others have one); for plain pages a small script and one
file per language is enough. Adding a package needs a yes.

## 2. Move the texts out

1. List every visible text: headings, buttons, labels, placeholders, errors, page titles, `alt` texts, emails the app
   sends. Do not forget texts made in code ("3 items", "Saved").
2. Give each a short key by where it is (`menu.title`, `form.send`) and put it in one file per language
   (`tr.json`, `en.json`, or the framework's format). Keys are the same in every file.
3. Replace each text in the code with its key. Change one screen at a time and check it still looks the same.

## 3. The details that break

- **Plural and counts:** "1 item / 2 items" differs by language; use the framework's plural rule, not string gluing.
- **Sentences with values:** keep the whole sentence in the file with a placeholder (`"{count} kişi"`); word order
  changes between languages.
- **Dates, numbers, money:** format with the language (`Intl.DateTimeFormat`, `Intl.NumberFormat`): 8 Eki 2026 and
  Oct 8, 2026; 1.250,50 ₺ and ₺1,250.50.
- **Turkish letters:** "i" and "ı" upper-case differently (`İ`, `I`); use the language when changing case.
- **Length:** German or Turkish text can be much longer; buttons and menus must not cut it.
- **Right-to-left** (Arabic, Hebrew): set `dir="rtl"` and check the layout mirrors.

## 4. The switch

A visible switch with each language written in itself ("Türkçe", "English"), not flags. Remember the choice (a
cookie, local storage or the address); the first visit may follow the browser's language. Set `<html lang="..">` to
the shown language, and for separate addresses add `hreflang` links between the versions.

## 5. Check

- Every key exists in every language file (a short script or the framework's check); no key is shown raw.
- Walk the main flow once in each language, on a phone-sized window too.
- Search the code for leftover hard-coded text in the main language.

## Do not use for

- Writing the texts themselves from scratch: use `docs-writer`.
- Layout problems not caused by text length: use `ui-check`.

## Done when

- Every visible text comes from one file per language, with the same keys in each, and none is shown raw.
- The switch works and is remembered; the page language attribute follows it.
- Dates, numbers and plurals follow the language.
- You listed which texts are machine translated and asked the user to have them read before publishing.
