# dsh-select-ask

English | [中文](README.zh.md)

Select text in the DSH Web UI conversation and either **quote** it into the composer or **ask about
it in a throwaway side panel** — the two habits Codex users have.

## What it does

**Quote.** Selecting text in the conversation (or anywhere outside an input) floats a small bar with
`引用` / `侧栏提问`. Quoting attaches an *annotation* to the composer instead of dumping the text
into it:

- a pill above the composer reads `1 条注释` / `1 quote`; hover it to list every annotation (numbered,
  with the quoted text), remove one, or clear all with the `×`;
- the composer text carries one icon-only chip per quote;
- on send, each chip expands into a Markdown blockquote in the message.

**Ask aside.** `侧栏提问` opens a right-sidebar tab pinned to the selected fragment. The tab is a
self-contained chat: each turn is one POST to a route the host half registers, which runs a single
tool-less `ctx.llm.stream` call. **No session is created** — no session log, no workspace entry, no
child session. The transcript lives in the tab component's state, so closing it discards everything.
Model and credentials still take the normal path (the selected session's current request config,
falling back to the default selection), so adapters, retries, credentials and metering behave exactly
as they do for an ordinary turn.

## How a quote reaches the model

A quote has to reach the model without filling the input box, so it rides the composer's own
**reference chip** mechanism rather than the draft text. Each quote is one chip whose `ref` *is* the
quoted text, whose draft projection is a short marker, and whose model form comes from this
package's own codec:

```js
ctx.inputTriggers.registerSource({
  trigger: "@",
  name: "select-ask",
  candidates: async () => [],       // no `@` menu group, no plain-text decoration
  showGroupTitle: false,
  codec: {
    clipboardText: () => "[注释]",   // what the draft text shows
    serialize: (ref) => Promise.resolve("\n\n" + blockquote(ref) + "\n"),  // what the model gets
  },
});
```

Insertion and removal use the composer's scoped input events — `slash/input-insert-reference` to
place a chip, `slash/input-consume-token` with its span to delete one. Both are CAS'd against the
live draft revision, so a keystroke that lands first wins the race and the edit is retried; a chip's
detect offset is derived from the occurrence list (`detectOffset = clipboardOffset − Σ(length−1)` of
the chips before it), which keeps the arithmetic correct whether or not other plugins' chips sit in
the same draft.

Because the pill counts the chips in the *draft* (`InputState.occurrences`), the count, the hover
list and the model text read the same data and cannot disagree. A serialization failure blocks the
send (`slash: no serializer for reference source …`) instead of silently sending the marker text.

If no chip can be inserted at all (no session scope, or the revision keeps racing), the plugin
degrades to appending the quote to the draft as text and says so on the console — ugly, never lost.

## Security

`/dsh-select-ask/ask` spends model quota, so it is guarded by `isTrustedRequest()`, a pure decision
over request headers with its own test (`node --test test/trusted-request.test.mjs`):

- **token armed** — an index render really delivered this activation's token to a page, so the
  request must carry it back in `x-dsh-select-ask`; everything else is refused. The host half injects
  the token with `webServer.tapIndex`; the browser half reads it from
  `window.__DSH_SELECT_ASK_TOKEN__`. A custom header also keeps cross-site form posts out.
- **token unarmed** — some deployments never route the window's index through
  `webServer.renderIndex` (observed on DSH Desktop 2.0.15), so the token never reaches a page. Then
  any request that declares a browser origin (`Origin`/`Referer`) must declare *our* origin, and a
  request with no origin at all is let through — it is no stronger a caller than the rest of the
  loopback surface a DSH profile already exposes.

`GET /dsh-select-ask/status` reports which mode is in force (`guard`) plus the resolved model.

## Install

```sh
# from a session with Full access:
# plugin_manager action=install_bundle target=<this directory>
```

Reload the Web UI page afterwards so the new client bundle enters the boot graph. A **host-half**
change (`host.js`) needs a DSH restart: the host module generation is cached per process, and a row's
specifier cannot be re-imported in place.

## Status

Developed and verified against **dsh core 0.2.0-rc.2** (DSH Desktop 2.0.15-beta.1). No `engines.dsh`
range is declared: only this version has actually been run.

## Notes for plugin authors

Things that cost time while building this, written down because they are not obvious:

- **The host module cache is keyed by the row's specifier for the life of the process.** Toggling a
  bundle off and on does not re-import it, and `install_bundle` on an already-installed bundle does
  not re-read its `cordis.patch.yml`. To make an edited host half live: `remove_bundle`, then
  `install_bundle`, with a row `name` that differs from the one already imported — or restart DSH.
- **A Loader row name must not be a subpath specifier.** `pkg/subpath` fails with
  `failed to import` here even though plain Node resolves it.
- **Client-half edits need a page reload** (client HMR only rebuilds while `pnpm run dev:web` runs).
- **A cordis service is readable as a property only inside a fiber that declared it.** Use
  `ctx.inject(['webServer'], (scope) => scope.webServer…)`; `ctx.get('webServer')` alone does not
  make `ctx.webServer` readable.
- **A user message bubble renders plain text plus chips, not Markdown.** The shipped
  `projectUserText` draws runs and turns only `@[label](dsh-session:…)` mentions, bare `@token`s and
  `/command`s into chips; Markdown links, HTML comments and the like are shown verbatim. So a plugin
  cannot hide content inside a user message — that would need a structured annotation field on the
  message, or the content has to travel outside it.

## Limitations

- Pending annotations live only in the composer's draft mirror. A page reload or a session switch
  while a quote is pending restores the marker as plain text and loses the quoted body (the plugin
  strips such orphan markers on mount so a bare `[注释]` is never sent as prose). Quotes already sent
  are in the message and unaffected.
- The quoted text is visible in the sent bubble as a Markdown blockquote. Hiding it there is not
  possible from a plugin: the bubble renders the message text itself (see above).
- In the composer each quote shows as an icon-only chip (`label: ""` plus `appearance: "session"`;
  without an appearance the chip would render a bare `@`).
- The side panel is a *page-type* tab: page types deduplicate within a pane, so asking again reuses
  the same tab and resets it with the new fragment.
- Side-panel answers are rendered as plain text (line breaks preserved); there is no Markdown
  renderer there.
- Text selected inside the side panel does not raise the toolbar again (no self-nesting).
- The toolbar writes into the **most recently mounted** composer; with a sidebar chat tab open that
  may not be the main session's.

## License

MIT — see [LICENSE](LICENSE).
