# `@tealbrick/ui`

Canonical web tokens and low-level components for standalone Teal Brick
Micro-apps. It is intentionally smaller than an application framework.

Import the tokens before application CSS:

```ts
import "@tealbrick/ui/tokens.css";
import "@tealbrick/ui/components.css";
```

Applications own their domain components and information architecture. This
package owns brand assets, tokens, primitive interaction vocabulary, focus and
motion behavior, and the small reusable components proven by reference apps.

The deployed Micro-app archive already carries `apps/.sdk` beside every
Program. Vite consumers should resolve `@tealbrick/ui` against the local or
packaged `.sdk/tealbrick-ui` source rather than copying it.
