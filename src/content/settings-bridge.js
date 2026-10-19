(() => {
  'use strict';

  // Only this isolated script can access extension storage. The shared DOM carries
  // a boolean preference, never credentials, requests or arbitrary page commands.
  let revision = 0;
  const apply = (enabled) => {
    document.documentElement.setAttribute('data-ytmq-enabled', String(enabled === true));
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    revision += 1;
    apply(changes.enabled.newValue ?? true);
  });

  const initialRevision = revision;
  chrome.storage.local.get({ enabled: true }).then((settings) => {
    // A storage change may arrive before the initial asynchronous read finishes.
    if (initialRevision === revision) apply(settings.enabled);
  }).catch((error) => {
    if (initialRevision === revision) apply(false);
    console.error('[YTM Queue] Не удалось прочитать настройки:', error);
  });
})();
