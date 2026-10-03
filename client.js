// dsh-select-ask — browser half (client plugin bundle).
//
// Two Codex-shaped habits, both built on the selection the user already made:
//
//   Quote        select text in the conversation, click 引用, and the fragment
//                lands in the composer as a Markdown blockquote, ready to
//                annotate. Nothing new is created: the draft is the message.
//
//   Ask aside    select text, click 侧栏提问, and a right-sidebar tab opens
//                with that fragment pinned as context. The tab is its own
//                little chat: it keeps a transcript in React state and calls
//                one host route per turn, which runs a session-free
//                `ctx.llm.stream` call. No session, no log, no workspace
//                entry — closing the tab discards the conversation, which is
//                exactly what Codex's side chat does.
//
// Where each piece lives (all additive, no shipped UI replaced):
//   shell.overlay                 the selection toolbar (frame-wide layer)
//   conversation.input.dock       a headless bridge that publishes the current
//                                 session's draft and `inputActions` upward
//   sidebar.right.pane.tab        the aside panel body, under this package's
//                                 registered tab kind
//   sidebar.right.pane.tab.title  the panel's chip title
//
// The bridge exists because the two halves live in different scopes: the
// toolbar is frame-wide (no session), while `inputActions` is a per-session
// composer face. The dock entry is the one place that sees the composer.

window.__ModuleLoader__.load({
  id: "dsh-select-ask-plugin",
  factory: (require) => {
    var React = require("react");
    var module = { exports: {} };
    var exports = module.exports;

    // ── Identity ─────────────────────────────────────────────────────────────
    /** Bundle package name. */
    var PACKAGE = "dsh-select-ask";
    /** Dictionary namespace owned by this plugin. */
    var NS = "dsh-select-ask";
    /** Tab-type implementation id == the keyed seat key. */
    var TAB_ID = "dsh-select-ask/aside";
    /** Page kind `openTab` names. */
    var ASK_KIND = "dsh-select-ask/aside";
    /** Host route that answers one panel turn. */
    var ROUTE = "/dsh-select-ask/ask";
    /** Global the served page reads the route token from (injected by the host half). */
    var TOKEN_GLOBAL = "__DSH_SELECT_ASK_TOKEN__";
    /** Header carrying that token. */
    var TOKEN_HEADER = "x-dsh-select-ask";
    /** Longest fragment pinned into a panel. */
    var MAX_CONTEXT_CHARS = 8000;
    /** Elements whose own selection is not ours to act on. */
    var EDITABLE = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
    /** Our own root, so a click on the toolbar never counts as a new selection. */
    var ROOT_ATTR = "data-dsh-select-ask-root";

    // ── Cross-scope bridge ───────────────────────────────────────────────────
    /**
     * The current session's composer, published by the input-dock entry. The
     * toolbar reads it; the dock entry writes it on every render.
     */
    var bridge = {
      /** Session the composer belongs to. */
      sessionId: null,
      /** Clipboard projection of the draft, kept current for append semantics. */
      draft: "",
      /** `InputActions` of that session's composer. */
      inputActions: null,
      /** Add one quote chip; set by the dock entry while it is mounted. */
      addQuote: null,
      /** Remove one quote chip by its ref (the quoted text). */
      removeQuote: null,
      /** Remove every quote chip. */
      clearQuotes: null,
    };
    /** `ctx.sidebarRight` once the service is available. */
    var sidebarRight = null;
    /** `ctx.sessions` once the service is available (mints each session's scoped ctx). */
    var sessionsService = null;
    /** Namespace-bound translate, replaced once the locale face is available. */
    var boundTranslate = null;

    /** The `t` a slot component should use: its own prop, else ours. */
    function translateOf(props) {
      if (props && typeof props.t === "function") return props.t;
      if (boundTranslate) return boundTranslate;
      return function (key) { return key; };
    }

    // ── Selection plumbing ───────────────────────────────────────────────────
    /**
     * The live selection, when it is one we should act on.
     * @returns `{ text, first, last }` (rects), or null.
     */
    function currentSelection() {
      var selection = window.getSelection ? window.getSelection() : null;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      var text = String(selection.toString() || "");
      if (text.replace(/\s+/g, "").length === 0) return null;
      var range = selection.getRangeAt(0);
      var node = range.commonAncestorContainer;
      var element = node && node.nodeType === 1 ? node : node ? node.parentElement : null;
      if (element && element.closest) {
        // A selection inside an input belongs to that input, and one inside the
        // toolbar belongs to us.
        if (element.closest(EDITABLE)) return null;
        if (element.closest("[" + ROOT_ATTR + "]")) return null;
      }
      var rects = range.getClientRects ? range.getClientRects() : null;
      var first = rects && rects.length > 0 ? rects[0] : null;
      var last = rects && rects.length > 0 ? rects[rects.length - 1] : null;
      if (!first && range.getBoundingClientRect) first = range.getBoundingClientRect();
      if (!first || (first.width === 0 && first.height === 0)) return null;
      return { text: text, first: first, last: last || first };
    }

    /** Wrap a fragment as a Markdown blockquote. */
    function quoteBlock(text) {
      return text.replace(/\s+$/, "").split(/\r?\n/).map(function (line) {
        return "> " + line;
      }).join("\n");
    }

    /** First non-empty line, trimmed and clipped: the panel chip's label. */
    function firstLine(text) {
      var lines = String(text || "").split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s+/g, " ").trim();
        if (line.length > 0) return line.length > 28 ? line.slice(0, 28) + "…" : line;
      }
      return "";
    }

    // ── Quotes as composer reference chips ───────────────────────────────────
    //
    // A quote must reach the model without filling the input box, so it rides the
    // composer's own reference mechanism instead of the draft text: each quote is
    // one chip whose draft projection is a short marker and whose model form is
    // the quote itself. The chip's `ref` IS the quoted text, which makes the draft
    // the only store — nothing can desynchronize — and lets the hover list, the
    // delete actions, and the model serialization all read the same bytes.
    //
    // The submit path expands every occurrence through the owning source's codec
    // (`serializeReference(source, ref, signal)`); a missing owner or codec
    // rejects the send rather than silently sending the marker text.

    /** Source name this plugin registers in the composer's trigger roster. */
    var QUOTE_SOURCE = "select-ask";
    /**
     * Whether the codec source is registered. A chip whose source has no codec
     * would *block* the send (the pipeline refuses to downgrade silently), so no
     * chip goes in until this is true.
     */
    var quoteCodecReady = false;

    /** The chip's draft/clipboard projection: what stands in for the quote in the text. */
    function quoteClipboardText() {
      return "[" + translateOf(null)("quoteToken") + "]";
    }

    /**
     * The chip's model form: the quote as a Markdown blockquote on its own lines.
     *
     * Nothing is hidden here on purpose. A marker form that kept the quote in a
     * Markdown link title (so the bubble would show only an icon) was tried and
     * abandoned: the durable user bubble showed the whole marker as raw text, and
     * reading the shipped renderer (`projectUserText` in the frontend bundle)
     * shows why it can be worse than that — that path renders plain runs plus
     * chips for `@[label](dsh-session:…)` mentions, plain `@token`s and
     * `/commands`, and does no Markdown at all. So a quote inside a user message
     * is visible text, and the readable form is the honest one.
     */
    function quoteSerialize(ref) {
      return Promise.resolve("\n\n" + quoteBlock(String(ref)) + "\n");
    }

    /** This plugin's quotes in one input state, in draft order. */
    function quoteOccurrences(state) {
      var list = state && Array.isArray(state.occurrences) ? state.occurrences : [];
      var mine = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].source === QUOTE_SOURCE) mine.push(list[i]);
      }
      return mine;
    }

    /**
     * Detect-coordinate geometry of every chip in the draft.
     *
     * The editor's detect projection counts each chip as one U+FFFC while the
     * clipboard projection carries the chip's whole `clipboardText`, so a chip's
     * detect offset is its clipboard offset minus one character per earlier chip.
     * @param state - one `InputState` snapshot.
     * @returns `{ spans, detectLength }` in detect coordinates.
     */
    function chipGeometry(state) {
      var list = state && Array.isArray(state.occurrences) ? state.occurrences : [];
      var draft = state && typeof state.draft === "string" ? state.draft : "";
      var spans = [];
      var shift = 0;
      for (var i = 0; i < list.length; i++) {
        var occurrence = list[i];
        var start = occurrence.offset - shift;
        shift += occurrence.length - 1;
        spans.push({ occurrence: occurrence, start: start, end: start + 1 });
      }
      return { spans: spans, detectLength: draft.length - shift };
    }

    /**
     * The session-scoped dispatch subject the scoped input events are routed
     * through: the very context the composer registered its listeners on, taken
     * from the session binding (falling back to the plain scope accessor).
     */
    function sessionCtx(sessionId) {
      if (!sessionsService || !sessionId) return null;
      try {
        if (typeof sessionsService.binding === "function") {
          var binding = sessionsService.binding(sessionId);
          if (binding && binding.ctx) return binding.ctx;
        }
        if (typeof sessionsService.scope === "function") {
          return sessionsService.scope(sessionId) || null;
        }
        return null;
      } catch (error) {
        return null;
      }
    }

    /** Emit one scoped input event; false when no listener applied it. */
    function dispatchInput(actx, name, payload) {
      try {
        return actx.bail(actx, name, payload) === true;
      } catch (error) {
        return false;
      }
    }

    /**
     * Put one quote chip at the end of the draft.
     * @param state - the live input state (its `draftRev` is the span CAS guard).
     * @param text - the quoted text, which also becomes the chip's ref.
     * @returns whether the chip is in the draft.
     */
    function insertQuoteChip(state, text) {
      if (!quoteCodecReady) return false;
      var actx = sessionCtx(bridge.sessionId);
      if (actx === null || !state) return false;
      var geometry = chipGeometry(state);
      return dispatchInput(actx, "slash/input-insert-reference", {
        reference: {
          source: QUOTE_SOURCE,
          ref: text,
          // Icon only, by choice: the label is the text the input box would show,
          // and the pill above it already reports how many annotations there are.
          // The `appearance` matters visually — without one the chip renders a
          // bare "@" marker instead of a glyph.
          label: "",
          appearance: "session",
          clipboardText: quoteClipboardText(),
        },
        span: {
          start: geometry.detectLength,
          end: geometry.detectLength,
          draftRev: state.draftRev,
        },
      });
    }

    /**
     * Remove one quote chip: the leftmost, or the one whose ref matches.
     * @returns whether a chip was removed.
     */
    function removeQuoteChip(state, ref) {
      var actx = sessionCtx(bridge.sessionId);
      if (actx === null || !state) return false;
      var geometry = chipGeometry(state);
      var draft = typeof state.draft === "string" ? state.draft : "";
      for (var i = 0; i < geometry.spans.length; i++) {
        var span = geometry.spans[i];
        if (span.occurrence.source !== QUOTE_SOURCE) continue;
        if (ref !== undefined && span.occurrence.ref !== ref) continue;
        var end = span.end;
        // The insert leaves one separating space behind the chip; take it too.
        if (draft.charAt(span.occurrence.offset + span.occurrence.length) === " ") end += 1;
        if (dispatchInput(actx, "slash/input-consume-token", {
          guard: { kind: "span", span: { start: span.start, end: end, draftRev: state.draftRev } },
        })) return true;
      }
      return false;
    }

    /** Add the fragment as a quote chip, or hand it over as text when there is no composer. */
    function insertQuote(text) {
      if (typeof bridge.addQuote === "function") {
        bridge.addQuote(text);
        return true;
      }
      appendQuoteToDraft(text);
      return false;
    }

    /**
     * Last resort for a quote that could not become a chip (no composer face, no
     * session scope, or the revision kept racing): put it in the draft as a
     * blockquote, which is uglier but never lost.
     */
    function appendQuoteToDraft(text) {
      var actions = bridge.inputActions;
      if (!actions || typeof actions.setDraft !== "function") {
        copyText(quoteBlock(text));
        return;
      }
      var current = typeof bridge.draft === "string" ? bridge.draft.replace(/\s+$/, "") : "";
      try {
        actions.setDraft((current.length > 0 ? current + "\n\n" : "") + quoteBlock(text) + "\n\n");
      } catch (error) {
        copyText(quoteBlock(text));
      }
    }

    /** Clipboard fallback; best-effort and silent (the page may deny it). */
    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text);
        }
      } catch (error) {
        /* nothing else to try */
      }
    }

    /**
     * Best-effort focus for the composer after a quote. The draft itself is
     * already inserted through the composer's own action face; this only puts
     * the caret where the user would have clicked, so typing continues after
     * the quote. Any failure is harmless and silent.
     */
    function focusComposer() {
      try {
        var nodes = document.querySelectorAll('[contenteditable="true"]');
        var best = null;
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          // The resident composer is the lowest editor on screen.
          if (rect.top < window.innerHeight * 0.35) continue;
          if (!best || rect.top > best.top) best = { node: node, top: rect.top };
        }
        if (!best) return;
        best.node.focus();
        var range = document.createRange();
        range.selectNodeContents(best.node);
        range.collapse(false);
        var selection = window.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (error) {
        /* focus is a nicety, never a requirement */
      }
    }

    /** Open the aside tab with the fragment pinned. */
    function askAside(text) {
      if (!sidebarRight || typeof sidebarRight.openTab !== "function") return false;
      try {
        sidebarRight.openTab(ASK_KIND, {
          params: {
            text: text.slice(0, MAX_CONTEXT_CHARS),
            sessionId: bridge.sessionId,
            title: firstLine(text),
          },
        });
        return true;
      } catch (error) {
        return false;
      }
    }

    // ── Styles ───────────────────────────────────────────────────────────────
    var TOOLBAR_CSS = [
      ".dsh-sa-bar{position:fixed;z-index:60;display:flex;align-items:center;gap:2px;padding:3px;",
      "border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);",
      "box-shadow:0 8px 24px rgba(0,0,0,0.18);pointer-events:auto;",
      "font-family:var(--dsw-font-family);font-size:12px;line-height:1;color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-bar[data-below=true]{transform:translate(-50%,0)}",
      ".dsh-sa-bar[data-below=false]{transform:translate(-50%,-100%)}",
      ".dsh-sa-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:0;border-radius:6px;",
      "background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap}",
      ".dsh-sa-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sa-btn:active{background:var(--dsw-alias-interactive-bg-active)}",
      ".dsh-sa-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;background:transparent}",
      ".dsh-sa-sep{width:1px;height:14px;background:var(--dsw-alias-border-l1)}",
    ].join("");

    var PANEL_CSS = [
      ".dsh-sa-panel{display:flex;flex-direction:column;flex:auto;height:100%;min-height:0;",
      "font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size-secondary,13px);",
      "color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}",
      ".dsh-sa-context{flex:none;padding:10px 12px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}",
      ".dsh-sa-contextLabel{display:flex;align-items:center;justify-content:space-between;gap:8px;",
      "font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-contextText{margin:6px 0 0;max-height:92px;overflow:auto;white-space:pre-wrap;word-break:break-word;",
      "font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);",
      "border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}",
      ".dsh-sa-thread{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;",
      "scrollbar-color:var(--dsw-alias-scrollbar-thumb-l1) transparent}",
      ".dsh-sa-empty{margin:auto;padding:0 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}",
      ".dsh-sa-msg{max-width:100%;white-space:pre-wrap;word-break:break-word;line-height:1.6}",
      ".dsh-sa-msg[data-role=user]{align-self:flex-end;max-width:88%;padding:6px 10px;border-radius:10px;",
      "background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2))}",
      ".dsh-sa-msg[data-role=assistant]{align-self:stretch;color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-msg[data-pending=true]{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sa-error{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sa-editor{flex:none;border-top:0.5px solid var(--dsw-alias-border-l3);padding:8px 10px 6px}",
      ".dsh-sa-box{display:flex;align-items:flex-end;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);",
      "border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:6px 6px 6px 10px}",
      ".dsh-sa-box:focus-within{border-color:var(--dsw-alias-state-business-primary)}",
      ".dsh-sa-input{flex:1;min-width:0;max-height:120px;border:0;outline:0;resize:none;background:transparent;",
      "font:inherit;line-height:1.55;color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-send{flex:none;height:26px;padding:0 10px;border:0;border-radius:6px;cursor:pointer;font:inherit;",
      "font-size:12px;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));",
      "color:var(--dsw-alias-brand-text,#fff)}",
      ".dsh-sa-send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}",
      ".dsh-sa-send:disabled{opacity:.5;cursor:default}",
      ".dsh-sa-foot{margin:6px 2px 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-tabTitle{display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ].join("");

    /** Annotation pill and its hover list; host theme tokens only. */
    var NOTES_CSS = [
      ".dsh-sa-notes{position:relative;display:inline-flex;align-items:center;gap:2px;margin:0 0 6px;",
      "pointer-events:auto;font-family:var(--dsw-font-family);font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sa-notesPill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;cursor:pointer;",
      "border:0.5px solid var(--dsw-alias-border-l2);border-radius:13px;background:var(--dsw-alias-bg-layer-2);",
      "color:inherit;font:inherit;white-space:nowrap}",
      ".dsh-sa-notesPill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-notesPill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-notesGlyph{font-size:11px;opacity:0.75}",
      ".dsh-sa-notesClear{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;",
      "cursor:pointer;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);",
      "font:inherit;font-size:14px;line-height:1}",
      ".dsh-sa-notesClear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-notesPanel{position:absolute;left:0;bottom:calc(100% + 6px);z-index:40;width:min(560px,78vw);",
      "max-height:340px;overflow:auto;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);",
      "border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,0.18);",
      "color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-noteRow{padding:2px 0}",
      ".dsh-sa-noteRow + .dsh-sa-noteRow{margin-top:10px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l3)}",
      ".dsh-sa-noteHead{display:flex;align-items:center;gap:8px}",
      ".dsh-sa-noteIndex{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-noteLabel{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sa-noteRemove{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;",
      "padding:0;cursor:pointer;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1}",
      ".dsh-sa-noteRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sa-noteText{margin:4px 0 0;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-word;",
      "font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}",
      ".dsh-sa-noteFoot{margin:10px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
    ].join("");

    // ── Dictionaries ─────────────────────────────────────────────────────────
    /** UI copy, keyed the same in both languages. */
    var zh = {
      quote: "引用",
      ask: "侧栏提问",
      quoteTitle: "把选中的文字加入输入框（作为注释，不展开正文）",
      askTitle: "在侧栏小窗中就此提问（不留下记录）",
      tabTitle: "侧栏提问",
      contextLabel: "已选内容",
      emptyHint: "就这段内容提问。例如：这个概念是什么意思？",
      placeholder: "输入问题，Enter 发送，Shift+Enter 换行",
      send: "发送",
      stop: "停止",
      thinking: "正在回答…",
      footnote: "此小窗的对话只存在于当前页面，关闭后不留任何记录。",
      unavailable: "侧栏服务当前不可用。",
      noSelection: "请先选中一段文字。",
      stalePage: "这个页面是在插件生效之前打开的：刷新页面（⌘R）后即可使用侧栏提问。",
      quoteToken: "注释",
      noteCount: "{n} 条注释",
      notesTitle: "已加入输入框的注释（鼠标移上去查看内容）",
      quotedTextLabel: "所选文本",
      removeOne: "删除这条注释",
      clearAll: "清除全部注释",
      notesFoot: "发送时这些注释会作为引用附在消息里；也可以在输入框中用退格键逐条删除。",
    };

    var en = {
      quote: "Quote",
      ask: "Ask aside",
      quoteTitle: "Add the selected text to the composer as an annotation",
      askTitle: "Ask about this in the side panel (leaves no record)",
      tabTitle: "Ask aside",
      contextLabel: "Selected",
      emptyHint: "Ask about this fragment. For example: what does this concept mean?",
      placeholder: "Ask something — Enter sends, Shift+Enter adds a line",
      send: "Send",
      stop: "Stop",
      thinking: "Answering…",
      footnote: "This panel lives only in the current page; closing it leaves no record.",
      unavailable: "The sidebar service is unavailable.",
      noSelection: "Select some text first.",
      stalePage: "This page was opened before the plugin became live: reload it (⌘R) and the side panel will work.",
      quoteToken: "quote",
      noteCount: "{n} quote(s)",
      notesTitle: "Annotations added to the composer (hover to read them)",
      quotedTextLabel: "Quoted text",
      removeOne: "Remove this annotation",
      clearAll: "Clear all annotations",
      notesFoot: "These annotations ride the message as quotes when you send; backspace in the composer removes one too.",
    };

    // ── Selection toolbar (shell.overlay) ────────────────────────────────────
    /**
     * The floating bar itself. It lives in the frame-wide overlay, so it can sit
     * above any column; the composer it writes into is reached through the
     * bridge published by the input-dock entry.
     * @param props - slot props; only `t` is used.
     */
    function SelectionToolbar(props) {
      var t = translateOf(props);
      var pair = React.useState(null);
      var state = pair[0];
      var setState = pair[1];

      React.useEffect(function () {
        var frame = 0;
        function measure() {
          frame = 0;
          var info = currentSelection();
          if (!info) {
            setState(null);
            return;
          }
          // Width is only needed to keep the bar inside the viewport; the real
          // width is content-sized, so clamp on the anchor and let CSS center it.
          var halfWidth = 120;
          var anchor = info.first;
          var below = anchor.top < 64;
          var top = below ? info.last.bottom + 8 : anchor.top - 8;
          var left = Math.min(
            Math.max(anchor.left + anchor.width / 2, halfWidth + 8),
            Math.max(window.innerWidth - halfWidth - 8, halfWidth + 8),
          );
          setState({ text: info.text, left: left, top: top, below: below });
        }
        function schedule() {
          if (frame) return;
          frame = window.requestAnimationFrame(measure);
        }
        function hide() {
          setState(null);
        }
        function onPointerDown(event) {
          var target = event.target;
          if (target && target.closest && target.closest("[" + ROOT_ATTR + "]")) {
            // Keep the selection alive while the click lands on our buttons.
            event.preventDefault();
            return;
          }
          hide();
        }
        function onKeyDown(event) {
          if (event.key === "Escape") hide();
        }
        document.addEventListener("mouseup", schedule, true);
        document.addEventListener("keyup", schedule, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("scroll", hide, true);
        window.addEventListener("resize", hide);
        window.addEventListener("blur", hide);
        return function () {
          if (frame) window.cancelAnimationFrame(frame);
          document.removeEventListener("mouseup", schedule, true);
          document.removeEventListener("keyup", schedule, true);
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("scroll", hide, true);
          window.removeEventListener("resize", hide);
          window.removeEventListener("blur", hide);
        };
      }, []);

      if (!state) return null;

      function onQuote() {
        insertQuote(state.text);
        setState(null);
      }

      function onAsk() {
        askAside(state.text);
        setState(null);
      }

      return React.createElement(
        "div",
        {
          className: "dsh-sa-bar",
          "data-below": state.below ? "true" : "false",
          [ROOT_ATTR]: "bar",
          style: { left: state.left + "px", top: state.top + "px" },
          role: "toolbar",
          "aria-label": t("tabTitle"),
        },
        React.createElement("style", null, TOOLBAR_CSS),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sa-btn",
            title: t("quoteTitle"),
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: onQuote,
          },
          t("quote"),
        ),
        React.createElement("span", { className: "dsh-sa-sep", "aria-hidden": "true" }),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sa-btn",
            title: t("askTitle"),
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: onAsk,
          },
          t("ask"),
        ),
      );
    }

    // ── Composer dock: bridge + annotation pill ──────────────────────────────
    /**
     * Two jobs in the one session-scoped seat the composer gives a plugin:
     *
     * - publish the session's composer face onto the bridge, because the
     *   selection toolbar is frame-wide and has no session of its own;
     * - render the annotation pill — how many quotes ride the draft, and what
     *   they say when the pointer rests on it.
     *
     * The pill counts the chips in the *draft*, so it can never claim something
     * the message would not carry.
     * @param props - `useInput`, `inputActions`, `sessionId`.
     */
    function ComposerBridge(props) {
      var t = translateOf(props);
      var useInput = typeof props.useInput === "function" ? props.useInput : null;
      var state = useInput ? useInput(function (value) { return value; }) : null;
      var openPair = React.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var closeTimer = React.useRef(0);
      var stateRef = React.useRef(state);
      stateRef.current = state;

      var mine = quoteOccurrences(state);
      var count = mine.length;

      bridge.sessionId = props.sessionId || null;
      bridge.inputActions = props.inputActions || null;
      bridge.draft = state && typeof state.draft === "string" ? state.draft : "";

      /**
       * Run one chip edit against the freshest state, retrying while the draft
       * revision races a keystroke (the span CAS refuses a stale revision).
       * @param operation - returns whether it applied.
       * @param repeat - keep going after a success (clearing several chips).
       */
      function runQuoteEdit(operation, repeat, onGiveUp) {
        var attempts = 0;
        function attempt() {
          if (operation(stateRef.current)) {
            if (repeat) {
              attempts = 0;
              window.setTimeout(attempt, 20);
            }
            return;
          }
          attempts += 1;
          if (attempts < 6) {
            window.setTimeout(attempt, 30);
            return;
          }
          if (onGiveUp) onGiveUp();
        }
        attempt();
      }

      var actions = props.inputActions;
      React.useEffect(function () {
        bridge.addQuote = function (text) {
          runQuoteEdit(
            function (current) { return insertQuoteChip(current, text); },
            false,
            function () {
              // Visible in the page console when the chip path is unavailable,
              // so a silent degradation is diagnosable.
              console.error(
                "[dsh-select-ask] quote chip insert failed (codec ready: " + quoteCodecReady
                + ", session scope: " + (sessionCtx(bridge.sessionId) !== null) + "); quoting as draft text",
              );
              appendQuoteToDraft(text);
            },
          );
          focusComposer();
        };
        bridge.removeQuote = function (ref) {
          runQuoteEdit(
            function (current) { return removeQuoteChip(current, ref); },
            false,
            // A refused removal must not be papered over: the chip really is
            // still in the draft, and the pill keeps telling that truth.
            function () { console.error("[dsh-select-ask] quote chip removal refused by the composer"); },
          );
        };
        bridge.clearQuotes = function () {
          runQuoteEdit(
            function (current) { return removeQuoteChip(current, undefined); },
            true,
            function () { console.error("[dsh-select-ask] quote chip removal refused by the composer"); },
          );
        };
        return function () {
          bridge.addQuote = null;
          bridge.removeQuote = null;
          bridge.clearQuotes = null;
          if (bridge.inputActions === actions) {
            bridge.inputActions = null;
            bridge.sessionId = null;
          }
        };
      }, [actions]);

      React.useEffect(function () {
        return function () {
          if (closeTimer.current) window.clearTimeout(closeTimer.current);
        };
      }, []);

      // The draft mirror stores the clipboard projection, so a reload or a
      // session switch during a pending quote restores my marker as plain text
      // with no chip behind it. Drop such orphan markers once, on mount, so a
      // bare "[注释]" never ships as literal prose.
      React.useEffect(function () {
        var actions = props.inputActions;
        var current = stateRef.current;
        if (!actions || typeof actions.setDraft !== "function") return;
        if (!current || typeof current.draft !== "string") return;
        // Any live chip at all (mine or another plugin's) means this draft is a
        // real edited document: rebuilding it as text would drop those chips.
        if (Array.isArray(current.occurrences) && current.occurrences.length > 0) return;
        var marker = quoteClipboardText();
        if (marker.length === 0 || current.draft.indexOf(marker) === -1) return;
        var cleaned = current.draft.split(marker).join("").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
        try {
          actions.setDraft(cleaned);
        } catch (error) {
          /* leave the draft alone */
        }
      }, []);

      React.useEffect(function () {
        if (!open) return undefined;
        function onKeyDown(event) {
          if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("keydown", onKeyDown, true);
        return function () {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open]);

      function openPanel() {
        if (closeTimer.current) {
          window.clearTimeout(closeTimer.current);
          closeTimer.current = 0;
        }
        setOpen(true);
      }

      function scheduleClose() {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(function () {
          closeTimer.current = 0;
          setOpen(false);
        }, 160);
      }

      if (count === 0) return React.createElement("span", { hidden: true, "aria-hidden": "true" });

      return React.createElement(
        "div",
        {
          className: "dsh-sa-notes",
          [ROOT_ATTR]: "notes",
          onMouseEnter: openPanel,
          onMouseLeave: scheduleClose,
        },
        React.createElement("style", null, NOTES_CSS),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sa-notesPill",
            "aria-expanded": open ? "true" : "false",
            title: t("notesTitle"),
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: function () { if (open) setOpen(false); else openPanel(); },
          },
          React.createElement("span", { className: "dsh-sa-notesGlyph", "aria-hidden": "true" }, "\u25A4"),
          t("noteCount").replace("{n}", String(count)),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sa-notesClear",
            title: t("clearAll"),
            "aria-label": t("clearAll"),
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: function () {
              if (typeof bridge.clearQuotes === "function") bridge.clearQuotes();
              setOpen(false);
            },
          },
          "\u00D7",
        ),
        open
          ? React.createElement(
            "div",
            { className: "dsh-sa-notesPanel", role: "group" },
            mine.map(function (occurrence, index) {
              return React.createElement(
                "div",
                { className: "dsh-sa-noteRow", key: occurrence.occurrenceId },
                React.createElement(
                  "div",
                  { className: "dsh-sa-noteHead" },
                  React.createElement("span", { className: "dsh-sa-noteIndex" }, String(index + 1) + "."),
                  React.createElement("span", { className: "dsh-sa-noteLabel" }, t("quotedTextLabel")),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dsh-sa-noteRemove",
                      title: t("removeOne"),
                      "aria-label": t("removeOne"),
                      onMouseDown: function (event) { event.preventDefault(); },
                      onClick: function () {
                        if (typeof bridge.removeQuote === "function") bridge.removeQuote(occurrence.ref);
                      },
                    },
                    "\u232B",
                  ),
                ),
                React.createElement("p", { className: "dsh-sa-noteText" }, occurrence.ref),
              );
            }),
            React.createElement("p", { className: "dsh-sa-noteFoot" }, t("notesFoot")),
          )
          : null,
      );
    }

    // ── Aside panel ──────────────────────────────────────────────────────────
    /** Parse one SSE frame block into its payload, or null. */
    function parseFrame(block) {
      var lines = String(block || "").split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("data:") !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        try {
          return JSON.parse(payload);
        } catch (error) {
          return null;
        }
      }
      return null;
    }

    /**
     * Run one panel turn against the host route.
     * @param request - `{ sessionId, context, messages, signal, onDelta }`.
     * @returns the full answer text.
     */
    async function requestAnswer(request) {
      var headers = { "content-type": "application/json" };
      var token = window[TOKEN_GLOBAL];
      if (typeof token === "string" && token.length > 0) headers[TOKEN_HEADER] = token;
      var response = await fetch(ROUTE, {
        method: "POST",
        headers: headers,
        signal: request.signal,
        body: JSON.stringify({
          sessionId: request.sessionId || undefined,
          context: request.context || undefined,
          messages: request.messages.map(function (message) {
            return { role: message.role, text: message.text };
          }),
        }),
      });
      if (!response.ok) {
        var detail = "";
        try {
          detail = await response.text();
        } catch (error) {
          detail = "";
        }
        // A page served before the host half was live carries no route token;
        // say what to do rather than showing a bare 403.
        var refusal = new Error(detail || ("HTTP " + response.status));
        refusal.stalePage = response.status === 403;
        throw refusal;
      }
      if (!response.body) throw new Error("no response stream");
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var text = "";
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var blocks = buffer.split("\n\n");
        buffer = blocks.pop();
        for (var i = 0; i < blocks.length; i++) {
          var frame = parseFrame(blocks[i]);
          if (!frame) continue;
          if (frame.type === "delta" && typeof frame.text === "string") {
            text += frame.text;
            request.onDelta(frame.text);
          } else if (frame.type === "error") {
            throw new Error(frame.message || "stream error");
          }
        }
      }
      return text;
    }

    /**
     * The panel body: a transcript in component state, one host call per turn,
     * and nothing persisted anywhere.
     * @param props - tab seat props: `useTabInfo`, `sessionId`, `t`.
     */
    function AsideBody(props) {
      var useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : null;
      var info = useTabInfo ? useTabInfo() : null;
      var navigation = info && info.tab ? info.tab.navigation : null;
      var params = navigation ? navigation.params : null;
      var seed = params && typeof params.text === "string" ? params.text : "";
      var sessionId = params && params.sessionId ? params.sessionId : (props.sessionId || null);
      var revision = navigation ? navigation.revision : 0;
      var t = translateOf(props);

      var messagesPair = React.useState([]);
      var messages = messagesPair[0];
      var setMessages = messagesPair[1];
      var draftPair = React.useState("");
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = React.useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];

      var abortRef = React.useRef(null);
      var threadRef = React.useRef(null);
      var revisionRef = React.useRef(null);

      // A fresh navigation (the user selected something else) starts a fresh
      // conversation in the same tab: pages deduplicate, so this is the only
      // way "ask about this" can mean a new question.
      React.useEffect(function () {
        if (revisionRef.current === revision) return;
        revisionRef.current = revision;
        if (abortRef.current) abortRef.current.abort();
        setMessages([]);
        setDraft("");
        setError(null);
        setBusy(false);
      }, [revision]);

      // Follow the tail while an answer streams in.
      React.useEffect(function () {
        var node = threadRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages, busy]);

      // Leaving the panel (or switching session) drops the transcript; the
      // in-flight request goes with it.
      React.useEffect(function () {
        return function () {
          if (abortRef.current) abortRef.current.abort();
        };
      }, []);

      function send() {
        var question = draft.trim();
        if (question.length === 0 || busy) return;
        var history = messages.concat([{ role: "user", text: question }]);
        setMessages(history.concat([{ role: "assistant", text: "" }]));
        setDraft("");
        setError(null);
        setBusy(true);
        var controller = new AbortController();
        abortRef.current = controller;
        requestAnswer({
          sessionId: sessionId,
          context: seed,
          messages: history,
          signal: controller.signal,
          onDelta: function (delta) {
            setMessages(function (current) {
              var next = current.slice();
              var last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { role: "assistant", text: last.text + delta };
              }
              return next;
            });
          },
        }).then(
          function () {
            setBusy(false);
            abortRef.current = null;
          },
          function (failure) {
            setBusy(false);
            abortRef.current = null;
            // A cancelled turn keeps whatever arrived; a real failure says so.
            if (failure && failure.name === "AbortError") return;
            setMessages(function (current) {
              var next = current.slice();
              var last = next[next.length - 1];
              if (last && last.role === "assistant" && last.text.length === 0) next.pop();
              return next;
            });
            setError(failure && failure.stalePage ? t("stalePage") : String((failure && failure.message) || failure));
          },
        );
      }

      function stop() {
        if (abortRef.current) abortRef.current.abort();
        setBusy(false);
      }

      if (!sidebarRight && !navigation) {
        // Opened outside a mounted right sidebar: nothing to show.
        return React.createElement(
          "div",
          { className: "dsh-sa-panel" },
          React.createElement("style", null, PANEL_CSS),
          React.createElement("p", { className: "dsh-sa-note", style: { padding: "12px" } }, t("unavailable")),
        );
      }

      return React.createElement(
        "div",
        { className: "dsh-sa-panel", [ROOT_ATTR]: "panel" },
        React.createElement("style", null, PANEL_CSS),
        seed.length > 0
          ? React.createElement(
            "div",
            { className: "dsh-sa-context" },
            React.createElement("div", { className: "dsh-sa-contextLabel" }, t("contextLabel")),
            React.createElement("p", { className: "dsh-sa-contextText" }, seed),
          )
          : null,
        React.createElement(
          "div",
          { className: "dsh-sa-thread", ref: threadRef },
          messages.length === 0 && !busy
            ? React.createElement("p", { className: "dsh-sa-empty" }, t("emptyHint"))
            : messages.map(function (message, index) {
              var pending = message.role === "assistant" && message.text.length === 0;
              return React.createElement(
                "div",
                {
                  className: "dsh-sa-msg",
                  "data-role": message.role,
                  "data-pending": pending ? "true" : "false",
                  key: index,
                },
                pending ? t("thinking") : message.text,
              );
            }),
          error !== null ? React.createElement("p", { className: "dsh-sa-error" }, error) : null,
        ),
        React.createElement(
          "div",
          { className: "dsh-sa-editor" },
          React.createElement(
            "div",
            { className: "dsh-sa-box" },
            React.createElement("textarea", {
              className: "dsh-sa-input",
              rows: 1,
              value: draft,
              placeholder: t("placeholder"),
              spellCheck: false,
              onChange: function (event) { setDraft(event.currentTarget.value); },
              onKeyDown: function (event) {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault();
                  send();
                }
              },
            }),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-sa-send",
                disabled: !busy && draft.trim().length === 0,
                onClick: busy ? stop : send,
              },
              busy ? t("stop") : t("send"),
            ),
          ),
          React.createElement("p", { className: "dsh-sa-foot" }, t("footnote")),
        ),
      );
    }

    /**
     * The chip title: the fragment's first line when the opener supplied one,
     * else the generic name.
     * @param props - tab title seat props.
     */
    function AsideTitle(props) {
      var t = translateOf(props);
      var useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : null;
      var info = useTabInfo ? useTabInfo() : null;
      var params = info && info.tab ? info.tab.navigation.params : null;
      var label = params && typeof params.title === "string" && params.title.length > 0 ? params.title : t("tabTitle");
      return React.createElement("span", { className: "dsh-sa-tabTitle" }, label);
    }

    // ── Plugin body ──────────────────────────────────────────────────────────
    /**
     * Register dictionaries, the dock bridge, the overlay toolbar, and — when
     * the sidebar service is present — the aside tab type, body, and title.
     * @param ctx - Restricted Cordis Context.
     */
    function apply(ctx) {
      try {
        boundTranslate = ctx.locale.bind(NS);
      } catch (error) {
        boundTranslate = null;
      }

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-select-ask: dictionaries");

      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register({
          name: "conversation.input.dock",
          id: "select-ask-bridge",
          order: 40,
          locale: NS,
        }, ComposerBridge);
      });

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "select-ask-toolbar",
          order: 90,
          locale: NS,
        }, SelectionToolbar);
      });

      // The quote chips need two composer-side services: the trigger roster that
      // resolves a chip's model text at submit, and the session scope that owns
      // the scoped input events. Neither is required for the side panel, so both
      // are soft dependencies.
      ctx.inject(["inputTriggers"], function (scope) {
        var triggers = scope.inputTriggers;
        if (!triggers || typeof triggers.registerSource !== "function") return;
        scope.effect(function () {
          var dispose = triggers.registerSource({
            // The codec is what matters: a chip tells the trigger pipeline which
            // source serializes it. No candidates and no lexicon keep this source
            // out of the `@` menu and out of plain-text decoration.
            trigger: "@",
            name: QUOTE_SOURCE,
            order: 100,
            showGroupTitle: false,
            candidates: function () { return Promise.resolve([]); },
            onPick: function () { return undefined; },
            codec: { clipboardText: quoteClipboardText, serialize: quoteSerialize },
          });
          quoteCodecReady = true;
          return function () {
            quoteCodecReady = false;
            dispose();
          };
        }, "dsh-select-ask: quote codec");
      });

      ctx.inject(["sessions"], function (scope) {
        sessionsService = scope.sessions;
      });

      // The panel needs the right column's tab registry; without it the quote
      // half still works, so this is a soft dependency.
      ctx.inject(["sidebarRightTabs"], function (scope) {
        var tabs = scope.sidebarRightTabs;
        if (!tabs || typeof tabs.register !== "function") return;
        scope.effect(function () {
          return tabs.register({
            id: TAB_ID,
            kind: ASK_KIND,
            priority: "extension",
            // Chip text captured at open time; a live title occupant (below)
            // replaces it with the fragment's first line when there is one.
            title: function () { return boundTranslate ? boundTranslate("tabTitle") : "Ask aside"; },
          });
        }, "dsh-select-ask: tab type");
        scope.effect(function () {
          return ctx.slots.inject("sidebar.right.pane.tab", function () {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab",
              key: TAB_ID,
              locale: NS,
            }, AsideBody);
          });
        }, "dsh-select-ask: aside body");
        scope.effect(function () {
          return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab.title",
              key: TAB_ID,
              locale: NS,
            }, AsideTitle);
          });
        }, "dsh-select-ask: aside title");
      });

      ctx.inject(["sidebarRight"], function (scope) {
        sidebarRight = scope.sidebarRight;
        scope.effect(function () {
          return function () {
            if (sidebarRight === scope.sidebarRight) sidebarRight = null;
          };
        }, "dsh-select-ask: sidebar handle");
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
