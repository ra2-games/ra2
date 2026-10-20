# UI directory

Organize by page ownership, keeping each page's components, state, hooks, and styles together. Currently there is only a game page. Resource selection, map management, and network status are regions/dialogs within it, without separate routes.

```text
ui/
  pages/
    game/
      AppShell.tsx       Game component tree and VM lifecycle entry
      page.ts           Page composition, resource selection, input/toolbar wiring
      components/       Resource picker, toolbar, dialogs, startup/debug panels
      hooks/            File picker and web-wheel adapters
      state/            Game-page state and user-input requests
      styles.css        Page styles
      vendor/           Game-frame upscaling models and licenses
      ...               Page-specific input, rendering, resource import modules
  shared/
    components/         Application error boundary
    state/              Generic store and React subscription hook
    i18n/               Typed English/Chinese messages and browser locale selection
```

`src/main.ts` mounts the React root; `index.html` supplies the game-page entry. Page-specific components do not belong in `shared`, and shared modules must not depend back on pages.

Runtime modules remain in `adapter/` and `vm86/`. File contracts, pure providers, and detection belong to `resources/`; browser file implementations to `platform/browser/files/`; game definitions to `games/`. Do not move them into UI. See [Architecture](../../docs/ARCHITECTURE.md) for full responsibilities/dependencies.

`app/session/` owns VM session control, and `graphics/framePresenter.ts` owns presentation scheduling. The page injects only renderers, infrequent status callbacks, and development model factories, without duplicating rAF or model-cancellation logic in components.

Use typed `t` messages for ordinary UI and accessible text. Browser preferences select English or Simplified Chinese when the page opens; unsupported preferences fall back to English. Game resources keep their own language. Existing metadata/diagnostics are localized only at presentation boundaries; runtime layers do not import UI catalogs. Experimental Workers inherit the page locale explicitly. See [React maintenance](../../docs/REACT_UI.md).

File moves must update static imports, Vite dynamic-import paths in browser tests, GLSL `?raw` paths, and documentation. Do not retain forwarding files in old directories and create duplicate entry points. `tests/basic/reactUiArchitecture.test.ts` checks directory/shared-dependency boundaries.
