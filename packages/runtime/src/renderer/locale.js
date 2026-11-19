export function deckLocale() {
  try { return globalThis.localStorage?.getItem('praxis.locale') === 'zh' ? 'zh-CN' : 'en'; }
  catch { return 'en'; }
}
export function t(english, chinese) { return deckLocale() === 'en' ? english : chinese; }
export function bindLanguageSwitch(button) {
  document.documentElement.lang = deckLocale();
  if (!button) return;
  button.textContent = t('简体中文', 'English');
  button.onclick = () => {
    const next = t('zh', 'en');
    localStorage.setItem('praxis.locale', next);
    document.cookie = 'praxis_locale=' + next + '; Path=/; SameSite=Lax; Max-Age=31536000' + (location.protocol === 'https:' ? '; Secure' : '');
    location.reload();
  };
}
