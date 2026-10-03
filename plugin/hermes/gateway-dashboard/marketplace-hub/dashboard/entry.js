/**
 * Marketplace gateway adapter dashboard entry.
 *
 * The HDDA Capabilities host renders Marketplace's normalized records; this
 * hidden component exists because the Hermes dashboard loader requires every
 * dashboard manifest to register its declared entry. It intentionally owns no
 * Capabilities tab, lifecycle control, or Marketplace settings form.
 */
(function registerMarketplaceGatewayAdapter() {
  "use strict";

  const sdk = window.__HERMES_PLUGIN_SDK__;
  const plugins = window.__HERMES_PLUGINS__;
  if (!sdk || !plugins || !sdk.React) return;

  const h = sdk.React.createElement;

  function MarketplaceGatewayAdapter() {
    return h(
      "section",
      { "data-marketplace-gateway-adapter": "marketplace-hub" },
      h("h2", null, "Marketplace gateway adapter"),
      h(
        "p",
        null,
        "Marketplace capabilities are rendered by the host-composed Capabilities surface.",
      ),
    );
  }

  plugins.register("marketplace-hub", MarketplaceGatewayAdapter);
})();
