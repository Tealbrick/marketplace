(function () {
  "use strict";

  const plugins = window.__HERMES_PLUGINS__;
  if (!plugins) return;

  // Marketplace contributes records and settings surfaces through its
  // authenticated backend adapter. The hidden component registration keeps
  // the dashboard plugin discoverable without adding a competing Hub tab.
  function MarketplaceHubProvider() {
    return null;
  }

  plugins.register("marketplace-hub", MarketplaceHubProvider);
})();
