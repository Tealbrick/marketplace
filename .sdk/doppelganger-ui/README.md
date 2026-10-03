# `@doppelganger/ui`

Canonical web tokens and low-level components for standalone Doppelganger
Micro-apps. It is intentionally smaller than an application framework.

Import the tokens before application CSS:

```ts
import "@doppelganger/ui/tokens.css";
import "@doppelganger/ui/components.css";
```

Applications own their domain components and information architecture. This
package owns brand assets, tokens, primitive interaction vocabulary, focus and
motion behavior, and the small reusable components proven by reference apps.

The deployed Micro-app archive already carries `apps/.sdk` beside every
Program. Vite consumers should resolve `@doppelganger/ui` against the local or
packaged `.sdk/doppelganger-ui` source rather than copying it.
