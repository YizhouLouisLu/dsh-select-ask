/**
 * dsh-select-ask — host half.
 *
 * The side panel's answer has to come from the model, and it must leave no
 * record. Every session-based route would: `sessionController.create` mints an
 * ordinary (visible) session, `subagents.prompt` continues an existing child,
 * and a session log is durable by construction. So this half does not touch
 * sessions at all. It registers two exact webServer routes and runs one
 * tool-less `ctx.llm.stream` call per panel turn:
 *
 *   GET  /dsh-select-ask/status  — is the bridge armed, and which model?
 *   POST /dsh-select-ask/ask     — { sessionId?, context?, messages[] } -> SSE
 *
 * Nothing is written to the session store, to `~/.dsh/sessions`, or anywhere
 * else: the panel's transcript lives only in the browser component's state, so
 * closing the tab discards it. That is the whole point of the feature.
 *
 * Model choice comes from the session the user selected in (its current request
 * header), falling back to the configured default selection; the request goes
 * through the ordinary provider adapters, so credentials, retries, and
 * telemetry behave as they do for a normal turn.
 *
 * Guard: the route hands out paid model calls, so it requires a per-process
 * token that is injected into the served index HTML. `tapIndex` flips
 * `tokenArmed`, so the guard is enforced exactly when the page actually
 * received the token — a deployment that never serves an index keeps working
 * without it instead of locking the feature out.
 */

import { randomUUID } from 'node:crypto';

/** Route namespace; exact paths, so nothing in the app claims them first. */
const PREFIX = '/dsh-select-ask';
const ASK_PATH = `${PREFIX}/ask`;
const STATUS_PATH = `${PREFIX}/status`;
/** Global the served page reads its token from. */
const TOKEN_GLOBAL = '__DSH_SELECT_ASK_TOKEN__';
/** Header the panel sends the token in. A custom header also blocks cross-origin CSRF. */
const TOKEN_HEADER = 'x-dsh-select-ask';
/** Request body cap. */
const MAX_BODY_BYTES = 512 * 1024;
/** Context and history caps: a side question is a short exchange, not a transcript. */
const MAX_CONTEXT_CHARS = 8000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20000;
/** Upper bound on one side answer, so a mis-prompted model cannot run long. */
const MAX_ANSWER_TOKENS = 2048;

/**
 * Whether one request may spend a model call.
 *
 * Two gates, and the strict one applies exactly when it can:
 *
 * - **Token armed** — an index render really delivered the token to a page, so
 *   the request must carry it back. Nothing else passes.
 * - **Token unarmed** — this deployment never injected the token into the page
 *   it serves (observed on DSH Desktop 2.0.15: the window's index does not come
 *   through `webServer.renderIndex`, so the tap never runs). Then a request that
 *   declares a browser origin must declare OUR origin: a cross-site page can
 *   send a simple, preflight-free POST, and this is what refuses it. A request
 *   with no origin at all (curl, another local process) passes, because it is no
 *   stronger a caller than the rest of the loopback surface this profile already
 *   exposes, and refusing it would risk locking out a page that omits the header.
 *
 * Exported for its own test: the decision is pure over request headers.
 *
 * @param headers - `IncomingMessage.headers`.
 * @param options - `{ token, tokenArmed }` from this activation.
 * @returns true when the request may proceed.
 */
export function isTrustedRequest(headers, options) {
  if (options?.tokenArmed) return headers?.[TOKEN_HEADER] === options.token;
  const source = headers?.origin ?? headers?.referer;
  if (typeof source !== 'string' || source.length === 0) return true;
  const host = headers?.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

/**
 * The side panel's own instruction. It is deliberately narrow: the panel shows
 * a selected fragment, so the model answers about that fragment and nothing
 * else, in the language the question was asked in.
 */
const SYSTEM_PROMPT = [
  'You are the DSH side panel: a small, throwaway question box the user opened',
  'about one fragment of a conversation.',
  '',
  'The first user message carries the fragment under "[selected text]". Treat it',
  'as the only context you have: never claim to know the rest of the',
  'conversation, the user\'s files, or their project.',
  '',
  'Answer the question directly and concisely. For "what is X" questions, lead',
  'with a one-sentence definition, then add only the detail the question needs.',
  'Use Markdown when it helps. Reply in the language the question is written in.',
].join('\n');

/**
 * Collect a request body up to {@link MAX_BODY_BYTES}.
 * @param req - the incoming request.
 * @returns the body as UTF-8 text.
 * @throws when the cap is exceeded.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** One JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** One SSE frame. */
function writeFrame(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Build the provider-neutral request messages.
 * @param body - the parsed request.
 * @returns `RequestMessage[]`, context first, then the panel history.
 */
function buildMessages(body) {
  const messages = [];
  const context = typeof body?.context === 'string' ? body.context.slice(0, MAX_CONTEXT_CHARS) : '';
  if (context.trim().length > 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `[selected text]\n${context}` }] });
  }
  const history = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  for (const entry of history) {
    const text = typeof entry?.text === 'string' ? entry.text.slice(0, MAX_MESSAGE_CHARS) : '';
    if (text.trim().length === 0) continue;
    messages.push({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text }],
    });
  }
  return messages;
}

/**
 * Resolve the route to call: the selected session's current request config
 * first (that is the model the user is talking to), then the configured
 * default.
 * @param ctx - plugin context.
 * @param sessionId - the panel's session, when it had one.
 * @returns `{ provider, model, reasoningEffort? }`, or undefined.
 */
function resolveModel(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions');
    const session = sessions && typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const config = session && typeof session.requestHeader === 'function'
      ? session.requestHeader()?.config
      : undefined;
    if (config?.provider && config?.model) {
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
    }
  } catch {
    /* Fall through to the configured default. */
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
    }
  } catch {
    /* No model is a reported condition, not a crash. */
  }
  return undefined;
}

/**
 * Host half of the bundle: install the two routes and the index token.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  /** Per-process secret; regenerated on every activation. */
  const token = randomUUID();
  /** Whether a served index actually carried the token (see the module doc). */
  let tokenArmed = false;

  const authorized = (req) => isTrustedRequest(req.headers, { token, tokenArmed });

  /** `GET /dsh-select-ask/status`: what the panel and a human can see. */
  const handleStatus = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const model = resolveModel(ctx, undefined);
    sendJson(res, 200, {
      ok: true,
      llm: typeof ctx.get('llm')?.stream === 'function',
      tokenRequired: tokenArmed,
      guard: tokenArmed ? 'token' : 'same-origin',
      model: model ? { provider: model.provider, model: model.model } : null,
    });
  };

  /** `POST /dsh-select-ask/ask`: one streamed, session-free model answer. */
  const handleAsk = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, { error: 'invalid-request', message: String(error?.message ?? error) });
      return;
    }
    const llm = ctx.get('llm');
    if (typeof llm?.stream !== 'function') {
      sendJson(res, 503, { error: 'llm-unavailable' });
      return;
    }
    const model = resolveModel(ctx, body?.sessionId);
    if (model === undefined) {
      sendJson(res, 503, { error: 'no-model' });
      return;
    }
    const messages = buildMessages(body);
    if (messages.length === 0) {
      sendJson(res, 400, { error: 'empty-request' });
      return;
    }

    // The client aborting its fetch (panel closed, session switched) closes the
    // socket; that cancels the provider call instead of leaving it running.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        system: SYSTEM_PROMPT,
        maxTokens: MAX_ANSWER_TOKENS,
        messages,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') {
          writeFrame(res, { type: 'delta', text: chunk.text });
        } else if (chunk?.type === 'finish') {
          const reason = chunk.reason;
          if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            writeFrame(res, { type: 'error', message: reason.failure?.message ?? reason.kind });
          } else {
            writeFrame(res, { type: 'done' });
          }
        }
      }
    } catch (error) {
      writeFrame(res, { type: 'error', message: String(error?.message ?? error) });
    } finally {
      res.off('close', onClose);
      res.end();
    }
  };

  /** Register both routes plus the index injection against a live webServer. */
  const registerRoutes = (scope) => {
    const web = scope.webServer;
    scope.effect(
      () => web.tapIndex((html) => {
        tokenArmed = true;
        const tag = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)};</script>`;
        return /<head(\s[^>]*)?>/i.test(html)
          ? html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${tag}`)
          : `${tag}${html}`;
      }),
      'dsh-select-ask: index token',
    );
    scope.effect(
      () => web.register({ kind: 'exact', path: STATUS_PATH, handler: handleStatus }),
      'dsh-select-ask: status route',
    );
    scope.effect(
      () => web.register({ kind: 'exact', path: ASK_PATH, handler: handleAsk }),
      'dsh-select-ask: ask route',
    );
  };

  // A child fiber that declares the dependency: cordis exposes an injected
  // service as a plain property only inside a fiber that asked for it, so this
  // is also what makes `scope.webServer` readable at all.
  ctx.inject(['webServer'], registerRoutes);
}
