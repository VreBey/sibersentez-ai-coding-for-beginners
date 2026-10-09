// @ts-check
// UI strings of the tool view (docs/tool-view.md): which AI tools see a project or an item. Same keys in en and tr;
// placeholders use {name}. Merged into the string table by public/js/i18n.js.
export default {
  en: {
    tvAllTools: 'All AI tools',
    tvFilterLabel: 'Show only what an AI tool sees',
    tvSeesCounts: 'Sees here: {projects} projects · {skills} skills · {agents} agents',
    tvSeesNothing: 'No project or skill of it found here yet',
  },
  tr: {
    tvAllTools: 'Bütün yapay zekâ araçları',
    tvFilterLabel: 'Yalnız bir yapay zekâ aracının gördüklerini göster',
    tvSeesCounts: 'Burada gördüğü: {projects} proje · {skills} skill · {agents} ajan',
    tvSeesNothing: 'Burada henüz projesi ya da skill’i bulunmadı',
  },
};
