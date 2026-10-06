// UI strings of "What changed" (public/js/changes.js). Same keys in en and tr; placeholders use {count}. Merged into
// the string table by public/js/i18n.js.
export default {
  en: {
    chgTitle: 'What changed',
    chgLoading: 'Looking at the project folder…',
    chgViaGit: 'Files not committed to git yet, newest first.',
    chgViaTime: 'Files changed in the last 24 hours, newest first (this folder has no git).',
    chgGitSkipped: 'Files changed in the last 24 hours. Git was not asked: this repository’s own settings could make it start a program.',
    chgNoneGit: 'Nothing changed since the last commit.',
    chgNoneTime: 'No file changed in the last 24 hours.',
    chgKind_new: 'New',
    chgKind_changed: 'Changed',
    chgKind_deleted: 'Deleted',
    chgKind_renamed: 'Moved',
    chgMore: '{count} more files',
    chgMoreMany: 'More files changed than shown here.',
  },
  tr: {
    chgTitle: 'Neler değişti?',
    chgLoading: 'Proje klasörüne bakılıyor…',
    chgViaGit: 'Git’e henüz kaydedilmemiş dosyalar, en yenisi üstte.',
    chgViaTime: 'Son 24 saatte değişen dosyalar, en yenisi üstte (bu klasörde git yok).',
    chgGitSkipped: 'Son 24 saatte değişen dosyalar. Git’e sorulmadı: bu deponun kendi ayarları git’e bir program çalıştırtabilir.',
    chgNoneGit: 'Son kayıttan (commit) beri bir şey değişmedi.',
    chgNoneTime: 'Son 24 saatte değişen dosya yok.',
    chgKind_new: 'Yeni',
    chgKind_changed: 'Değişti',
    chgKind_deleted: 'Silindi',
    chgKind_renamed: 'Taşındı',
    chgMore: '{count} dosya daha',
    chgMoreMany: 'Burada gösterilenden daha çok dosya değişti.',
  },
};
