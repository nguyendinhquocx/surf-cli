/**
 * Kimi Web Client for surf-cli
 *
 * Browser-session client for kimi.com (Moonshot AI - Kimi K-series models).
 * Drives the real kimi.com web UI through generic surf browser primitives
 * (NEW_TAB + EXECUTE_JAVASCRIPT + CLOSE_TAB), so no extension changes or
 * provider-specific CDP types are needed.
 *
 * Kimi's composer is a Lexical editor (`div[contenteditable][role="textbox"]`),
 * which rejects plain CDP Input.insertText events. We type via
 * document.execCommand("insertText") instead (proven to work with Lexical).
 */

const { abortableDelay, raceAbort, throwIfAborted } = require("./abort.cjs");

const KIMI_URL = "https://www.kimi.com/";
const DEFAULT_MODEL = "instant";

// Default models (best-effort labels; kimi.com UI may differ by plan/region)
const DEFAULT_KIMI_MODELS = {
  "instant": { id: "instant", name: "Instant", desc: "Fast responses" },
  "thinking": { id: "thinking", name: "Thinking", desc: "Deep reasoning (may need paid plan)" },
  "high": { id: "high", name: "High", desc: "Higher reasoning effort" },
};

function normalizeLabel(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getMatchLabels(desiredModel) {
  const labels = new Set([desiredModel]);
  for (const m of Object.values(DEFAULT_KIMI_MODELS)) {
    if (m.id === desiredModel) labels.add(m.name);
  }
  return Array.from(new Set(Array.from(labels).filter(Boolean).map(normalizeLabel)));
}

// ============================================================================
// Helpers
// ============================================================================

function delay(ms, signal) {
  return abortableDelay(ms, signal);
}

// In-page click dispatcher (pointerdown/mousedown/pointerup/click) - needed
// because plain el.click() is ignored by React/Lexical synthetic event systems.
function buildClickDispatcher() {
  return `function dispatchClickSequence(target) {
    if (!target || !(target instanceof EventTarget)) return false;
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of types) {
      const common = { bubbles: true, cancelable: true, view: window };
      let event;
      if (type.startsWith('pointer') && 'PointerEvent' in window) {
        event = new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
      } else {
        event = new MouseEvent(type, common);
      }
      target.dispatchEvent(event);
    }
    return true;
  }`;
}

// The chat composer input (Lexical editor) - prefer the specific class first to
// avoid matching sidebar search boxes
const INPUT_SELECTOR =
  "div.chat-input-editor, div[contenteditable=\"true\"][role=\"textbox\"], div[contenteditable=\"true\"]";

// Find the chat composer specifically: chat-input-editor class, or a textbox
// whose ancestors include the composer area
const FIND_INPUT_JS = `(() => {
  const direct = document.querySelector('div.chat-input-editor');
  if (direct) return direct;
  const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]'));
  for (const el of boxes) {
    const p = el.parentElement;
    if (!p) continue;
    const cls = ((p.className || '') + ' ' + ((p.parentElement && p.parentElement.className) || '')).toString();
    if (/chat-input|chat-editor|composer|publisher/.test(cls)) return el;
  }
  return boxes[0] || null;
})()`;

async function evaluate(jsEval, expression, signal) {
  throwIfAborted(signal);
  // IMPORTANT: always emit `return (expr);` so the eval works on BOTH the
  // current installed extension (wraps code as an async arrow body directly,
  // so a bare expression's value is discarded -> undefined) and a rebuilt one
  // (wraps with `return (code);` -> falls back to the raw code on syntax error).
  const code = /^\s*return\b/.test(expression) ? expression : `return (${expression});`;
  const result = await jsEval(code);
  throwIfAborted(signal);
  if (result && result.error) throw new Error(result.error);
  if (result && result.output !== undefined) {
    const output = result.output;
    if (output === "undefined") return undefined;
    try {
      return JSON.parse(output);
    } catch (e) {
      return output;
    }
  }
  return result;
}

// ============================================================================
// Page State
// ============================================================================

async function waitForPageLoad(jsEval, signal, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(jsEval, "document.readyState", signal);
      if (ready === "complete" || ready === "interactive") {
        await delay(1200, signal);
        return;
      }
    } catch (e) {
      // Page may not be reachable yet (mid-navigation); keep waiting
    }
    await delay(150, signal);
  }
  throw new Error("Page did not load in time");
}

async function checkLoginStatus(jsEval, signal) {
  const result = await evaluate(
    jsEval,
    `(() => {
      const body = (document.body.innerText || '').toLowerCase();
      const hasLogin = !!document.querySelector(
        'a[href*="/login"], a[href*="sign-in"], button[data-testid*="login"], a[href*="signup"]'
      );
      const loginWallWords = ['log in', 'sign in', 'sign up', '登录', '注册'];
      const looksLoggedOut = loginWallWords.some((w) => body.includes(w)) && !body.includes('ask anything');
      return {
        loggedIn: !hasLogin && !looksLoggedOut,
        url: location.href,
        bodyLen: body.length
      };
    })()`,
    signal
  );
  return result || { loggedIn: false, url: "", bodyLen: 0 };
}

async function waitForKimiReady(jsEval, signal, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs;
      let lastState = null;
      while (Date.now() < deadline) {
        let state = null;
        try {
          state = await evaluate(
            jsEval,
            `(() => {
              const input = ${FIND_INPUT_JS};
              const visible = !!input && input.offsetParent !== null;
              const body = (document.body.innerText || '');
              return { ready: visible, hasInput: visible, bodyLen: body.length, url: location.href };
            })()`,
            signal
          );
        } catch (e) {
          if (signal?.aborted) throw e;
          // Transient jsEval failure mid-SPA-load - keep waiting
        }
        lastState = state;
        if (state && state.ready) return state;
        await delay(250, signal);
      }
  if (lastState) {
    throw new Error(`Kimi chat UI not detected (current: ${lastState.url}) - may need to log in to kimi.com`);
  }
  throw new Error("Timed out waiting for Kimi chat UI");
}

// ============================================================================
// Model Selection (best-effort)
// ============================================================================

async function selectModel(jsEval, signal, desiredModel, timeoutMs = 8000) {
  const requestedLabels = getMatchLabels(desiredModel);
  if (requestedLabels.length === 0) return desiredModel;

  // The model picker (.current-model) renders late - wait for it (up to 6s)
  let modelClicked = null;
  const clickDeadline = Date.now() + 6000;
  while (Date.now() < clickDeadline && !(modelClicked && modelClicked.success)) {
    modelClicked = await evaluate(
      jsEval,
      `(() => {
        ${buildClickDispatcher()}
        // Kimi renders the model picker as div.current-model / div.model-name
        const modelDiv = document.querySelector('.current-model, .model-name, [class*="model-picker"], [class*="model-select"]');
        if (modelDiv && modelDiv.offsetParent !== null) {
          dispatchClickSequence(modelDiv);
          return { success: true };
        }
        const input = ${FIND_INPUT_JS};
        const scope = input
          ? (input.closest('[class*="composer"], [class*="input"], [role="form"], form') || input.parentElement)
          : document;
        const buttons = Array.from((scope || document).querySelectorAll('button'));
        const modelBtn = buttons.find((b) => {
          const text = (b.textContent || '').toLowerCase();
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          return /k2|k3|instant|thinking|deep|model/i.test(text) || label.includes('model');
        });
        if (modelBtn) { dispatchClickSequence(modelBtn); return { success: true }; }
        return { success: false };
      })()`,
      signal
    );
    if (!(modelClicked && modelClicked.success)) await delay(500, signal);
  }

  if (!modelClicked || !modelClicked.success) return desiredModel;
  await delay(900, signal);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(
      jsEval,
      `(() => {
        ${buildClickDispatcher()}
        const requestedLabels = ${JSON.stringify(requestedLabels)};
        const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        // Kimi model popover: .models-popover with plain div rows (no role attrs)
        const popover = document.querySelector('.models-popover') ||
          Array.from(document.querySelectorAll('.n-popover__content, .n-popover')).find((el) => el.offsetParent !== null && (el.textContent || '').length > 0);
        const candidates = popover
          ? Array.from(popover.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [class*="item"], div'))
          : Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]'));
        if (candidates.length === 0) return { waiting: true };
        let best = null, bestScore = 0;
        const seen = new Set();
        for (const item of candidates) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (item.offsetParent === null) continue;
          const text = norm(item.textContent || '');
          if (text.length < 2) continue;
          let score = 0;
          for (const label of requestedLabels) {
            if (!label) continue;
            if (text === label || text.startsWith(label)) score = Math.max(score, 100);
            else if (text.includes(label)) score = Math.max(score, 90);
          }
          if (score > bestScore) { bestScore = score; best = item; }
        }
        if (!best) return { found: true, success: false };
        dispatchClickSequence(best);
        return { found: true, success: true, model: (best.textContent || '').trim().split('\\n')[0] };
      })()`,
      signal
    );
    if (result && result.found) {
      if (result.success) { await delay(200, signal); return result.model; }
      await evaluate(jsEval, "document.body.click()", signal);
      throw new Error(`No matching model in menu for "${desiredModel}"`);
    }
    await delay(120, signal);
  }
  await evaluate(jsEval, "document.body.click()", signal);
  throw new Error(`Timed out waiting for model menu to show "${desiredModel}"`);
}

// Start a fresh chat - kimi.com restores the last session on home
async function startNewChat(jsEval, signal) {
  const clicked = await evaluate(
    jsEval,
    `(() => {
      ${buildClickDispatcher()}
      const btn = document.querySelector('a[aria-label="New Chat"], a.new-chat-btn, .sidebar-new-chat, a.logo');
      if (!btn || btn.offsetParent === null) return { success: false };
      dispatchClickSequence(btn);
      return { success: true };
    })()`,
    signal
  );
  if (clicked && clicked.success) {
    await delay(1800, signal);
  }
  return (clicked && clicked.success) || false;
}

// ============================================================================
// Input + Submission (Lexical-safe)
// ============================================================================

async function typePrompt(jsEval, signal, prompt) {
  const promptTail = normalizeLabel(prompt).slice(-30);
  const insertCode = (mode) => `(() => {
    const input = ${FIND_INPUT_JS};
    if (!input) return { success: false, error: 'input not found' };
    input.focus();
    const prompt = ${JSON.stringify(prompt)};
    let ok = false;
    if (${mode === 'fallback' ? 'true' : 'false'}) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: prompt
      }));
    }
    try {
      ok = document.execCommand('insertText', false, prompt);
    } catch (e) {
      ok = false;
    }
    return { ok, len: (input.textContent || '').length, cls: (input.className || '').toString().slice(0, 60) };
  })()`;
  const verifyCode = `(() => {
    const input = ${FIND_INPUT_JS};
    const text = (input ? input.textContent : '') || '';
    const tail = ${JSON.stringify(promptTail)};
    const plen = ${JSON.stringify(prompt.length)};
    const norm = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return { len: text.length, matched: tail ? norm.includes(tail) : text.length > 0, full: text.length >= plen };
  })()`;

  // 1. Focus the composer
  const focused = await evaluate(
    jsEval,
    `(() => {
      ${buildClickDispatcher()}
      const input = ${FIND_INPUT_JS};
      if (!input || input.offsetParent === null) return { success: false, error: 'input not visible' };
      input.scrollIntoView({ block: 'center' });
      dispatchClickSequence(input);
      input.focus();
      return { success: true };
    })()`,
    signal
  );
  if (!focused || !focused.success) {
    throw new Error(`Could not focus Kimi input: ${focused?.error || 'unknown'}`);
  }
  await delay(400, signal);

  // 2. Insert + poll for the async Lexical commit (up to 10s per attempt)
  const waitForText = async (attempt) => {
    const insert = await evaluate(jsEval, insertCode(attempt), signal);
    const deadline = Date.now() + 10000;
    let last = null;
    while (Date.now() < deadline) {
      last = await evaluate(jsEval, verifyCode, signal);
      if (last && last.matched && last.full && last.len > 0) return last;
      await delay(400, signal);
    }
    return last;
  };

  const result = await waitForText('primary');
  if (result && result.matched && result.full && result.len > 0) return;

  // 3. Fallback: clear composer, then selection + beforeinput + execCommand.
  // Clearing first prevents duplicated text when the primary insert partially
  // committed into the Lexical editor.
  const cleared = await evaluate(
    jsEval,
    `(() => {
      const input = ${FIND_INPUT_JS};
      if (!input) return { ok: false };
      input.focus();
      try {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
      } catch (e) { /* some engines ignore */ }
      return { ok: true };
    })()`,
    signal
  );
  void cleared;
  await delay(300, signal);
  const result2 = await waitForText('fallback');
  if (!result2 || !result2.matched || !result2.full || !result2.len) {
    const detail = result2 ? `(len=${result2.len}, full=${result2.full})` : '';
    throw new Error(`Kimi composer did not accept typed text ${detail}`);
  }
}

async function submitPrompt(jsEval, signal) {
  const clicked = await evaluate(
    jsEval,
    `(() => {
      ${buildClickDispatcher()}
      const input = ${FIND_INPUT_JS};
      const isVisible = (el) => el && el.offsetParent !== null;
      const isEnabled = (el) => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      // 1. Kimi's send control: a div.send-button-container (not a <button>)
      const container = document.querySelector('.send-button-container');
      if (container && isVisible(container) && isEnabled(container)) {
        dispatchClickSequence(container);
        return { success: true, method: 'send-button-container' };
      }
      const scope = input
        ? (input.closest('[class*="composer"], [class*="input"], [role="form"], form') || input.parentElement)
        : document;
      const buttons = Array.from((scope || document).querySelectorAll('button'));
      // 2. aria-label / text match
      const labeled = buttons.find((b) => {
        if (!isVisible(b) || !isEnabled(b)) return false;
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const txt = (b.textContent || '').trim().toLowerCase();
        return label === 'send' || label === 'submit' || label.startsWith('send ') ||
               label.includes('发送') || txt === 'send' || txt.includes('发送');
      });
      if (labeled) { dispatchClickSequence(labeled); return { success: true, method: 'label' }; }
      // 3. Last enabled visible button in the composer
      const candidates = buttons.filter((b) => isVisible(b) && isEnabled(b));
      if (candidates.length > 0) {
        dispatchClickSequence(candidates[candidates.length - 1]);
        return { success: true, method: 'last' };
      }
      return { success: false };
    })()`,
    signal
  );
  if (!clicked || !clicked.success) {
    throw new Error("Kimi send button not found");
  }
  await delay(600, signal);
}

// ============================================================================
// Response Handling
// ============================================================================

// Extract the assistant answer from full body innerText. Fresh tab per query
// means exactly one turn: user prompt line -> assistant reply -> input chrome.
function extractKimiResponse(bodyText, userPrompt = "") {
  if (!bodyText) return null;
  const lines = bodyText.split("\n").map((l) => l.trim()).filter((l) => l);
  if (lines.length === 0) return null;

  // UI chrome lines to drop (kimi sidebar + composer + message actions)
  const uiSet = new Set([
    "edit", "copy", "share", "regenerate", "like", "dislike", "stop", "stop generating",
    "new chat", "plugins", "scheduled tasks", "swarm", "slides", "deep research",
    "websites", "docs", "sheets", "design", "kimi work", "kimi code", "kimi claw",
    "projects", "new project", "chats", "all chats", "upgrade", "explore inspiration",
    "chat with kimi", "loading", "thinking...", "instant", "thinking", "high",
    "type \"/\" to invoke plugins and skills", "select project", "invite to earn",
    "up to 1-year k3 credits", "audiolibro vs libro", "kimi swarm definition",
    "kimi cline reddit views", "kimi api plugin", "hermes models add section",
    "hermes agent section update",
  ]);
  const isUI = (l) => {
    const key = l.toLowerCase().replace(/[.?!]+$/, "");
    if (uiSet.has(key) || uiSet.has(l.toLowerCase())) return true;
    // kimi footer / chrome prefix patterns
    const lower = l.toLowerCase();
    return (
      lower.startsWith("ask anything") ||
      lower.startsWith("high demand") ||
      lower.startsWith("upgrade to use") ||
      lower.startsWith("switched to k") ||
      lower.startsWith("kimi can make mistakes") ||
      lower.startsWith("kimi ai may") ||
      lower.startsWith("explore inspiration") ||
      lower.startsWith("new chat") ||
      lower.startsWith("projects") ||
      lower.startsWith("chats") ||
      lower.startsWith("plugins") ||
      lower.startsWith("live reminders") ||
      lower.startsWith("mark all as read") ||
      lower.startsWith("scroll to explore") ||
      lower.startsWith("too many people are chatting") ||
      lower.startsWith("subscribe to enter a dedicated priority queue") ||
      lower.startsWith("got it") ||
      lower === "completed" ||
      lower === "tips"
    );
  };

  // Locate the LAST occurrence of the user prompt (most recent turn).
  // Prefer an exact normalized line match: replies that echo the prompt
  // word ("hi", "ok") would otherwise match inside the reply and shift the
  // slice past the answer.
  const promptNorm = normalizeLabel(userPrompt).slice(0, 30);
  const promptLineNorms = String(userPrompt || "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(normalizeLabel);
  const findPromptSequence = () => {
    if (promptLineNorms.length < 2) return -1;
    for (let i = lines.length - promptLineNorms.length; i >= 0; i--) {
      let matches = true;
      for (let j = 0; j < promptLineNorms.length; j++) {
        if (normalizeLabel(lines[i + j]) !== promptLineNorms[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i + promptLineNorms.length - 1;
    }
    return -1;
  };
  const findPrompt = (exactOnly) => {
    if (!promptNorm) return -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const n = normalizeLabel(lines[i]);
      if (exactOnly ? n === promptNorm : n.includes(promptNorm)) return i;
    }
    return -1;
  };
  let lastIdx = findPromptSequence();
  if (lastIdx < 0) lastIdx = findPrompt(true);
  if (lastIdx < 0) lastIdx = findPrompt(false);
  let start = lastIdx >= 0 ? lastIdx + 1 : 0;

  // If everything after the prompt marker is UI chrome (e.g. a reply that
  // echoed the prompt and consumed the match), re-slice from the previous
  // occurrence of the prompt instead of returning chrome as the answer.
  const isChromeLine = (l) =>
    isUI(l) || (l.length <= 1 && !/^[\d.,%$€£+\-—]+$/.test(l));
  const sliceIsChrome = (from) =>
    lines.slice(from).every((l) => isChromeLine(l));
  if (sliceIsChrome(start) && lastIdx >= 0) {
    for (let i = lastIdx - 1; i >= 0; i--) {
      const n = normalizeLabel(lines[i]);
      if (n.includes(promptNorm)) { start = i + 1; break; }
    }
  }

  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isUI(line)) continue;
    if (line.length <= 1 && !/^[\d.,%$€£+\-—]+$/.test(line)) continue;
    out.push(line);
  }

  if (out.length > 0) return out.join("\n").trim();
  // Fallback: everything after the prompt marker, but only if it contains
  // substantive (non-chrome) content - otherwise the reply hasn't started yet
  const rest = lines
    .slice(start)
    .filter((l) => !isUI(l) && !(l.length <= 1 && !/^[\d.,%$€£+\-—]+$/.test(l)))
    .join("\n")
    .trim();
  return rest || null;
}

async function waitForResponse(jsEval, signal, timeoutMs = 300000, userPrompt = "") {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableCycles = 0;
  let lastChangeAt = Date.now();
  let lastResponse = "";

  while (Date.now() < deadline) {
    const snapshot = await evaluate(
      jsEval,
      `(() => {
        const bodyText = document.body.innerText || '';
        // Stop control while generating
        const stopBtn = Array.from(document.querySelectorAll('button')).find((b) => {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const txt = (b.textContent || '').toLowerCase().trim();
          return (label.includes('stop') || txt === 'stop' || txt.includes('stop generating') || label.includes('停止') || txt.includes('停止'));
        });
        const input = ${FIND_INPUT_JS};
        return {
          bodyText,
          hasStop: !!stopBtn && stopBtn.offsetParent !== null,
          inputReady: !!input && input.offsetParent !== null,
          url: location.href,
        };
      })()`,
      signal
    );
    if (!snapshot || !snapshot.bodyText) {
      await delay(350, signal);
      continue;
    }

        const response = extractKimiResponse(snapshot.bodyText, userPrompt);
        const current = response || "";

        // Free accounts see a priority-queue notice when Kimi is at capacity.
        // Fail fast with a clear error instead of a 300s silent timeout.
        if (!current && !snapshot.hasStop &&
            /too many people are chatting with kimi|subscribe to enter a dedicated priority queue/i.test(snapshot.bodyText)) {
          throw new Error(
            "Kimi is at capacity (priority-queue notice shown when no paid subscription is active); retry later"
          );
        }

    if (current !== lastResponse) {
      lastResponse = current;
      stableCycles = 0;
      lastChangeAt = Date.now();
    } else if (current.length > 0) {
      stableCycles++;
    }
    if (current !== lastText) lastText = current;

    const stableMs = Date.now() - lastChangeAt;
    const done = current.length > 0 && !snapshot.hasStop && snapshot.inputReady &&
                 (stableCycles >= 3 || stableMs >= 2000);

    if (done) {
      return { text: current, url: snapshot.url, partial: false };
    }
    await delay(400, signal);
  }

  // Timeout: return whatever we have
  const finalText = extractKimiResponse(lastText || "", userPrompt);
  if (finalText && finalText.trim().length > 0) {
    return { text: finalText, url: undefined, partial: true };
  }
  throw new Error("Response timeout - Kimi did not complete in time");
}

// ============================================================================
// Main Query
// ============================================================================

async function query(options) {
  const {
    prompt,
    extractionPrompt = prompt,
    model,
    timeout = 300000,
    createTab,
    closeTab,
    jsEval,
    log = () => {},
    signal,
  } = options;
  throwIfAborted(signal);

  const startTime = Date.now();
  log("Starting Kimi query");

  const tabInfo = await raceAbort(createTab, signal);
  const tabId = tabInfo && (tabInfo.tabId ?? (tabInfo.tabs && tabInfo.tabs[0] && tabInfo.tabs[0].tabId));
  if (!tabId) {
    throw new Error(`Failed to create Kimi tab: ${JSON.stringify(tabInfo)}`);
  }
  log(`Created tab ${tabId}`);

  const evalPage = (expression) => raceAbort(() => jsEval(tabId, expression), signal);

  try {
    await waitForPageLoad(evalPage, signal);
    log("Page loaded");

    const loginStatus = await checkLoginStatus(evalPage, signal);
    if (!loginStatus.loggedIn) {
      throw new Error("kimi.com login required - log in to kimi.com in your browser first");
    }
    log(`Login: yes (${loginStatus.url})`);

    await waitForKimiReady(evalPage, signal);
    log("Kimi ready");

    // Fresh chat (kimi.com may restore the previous session)
    try {
      await startNewChat(evalPage, signal);
      log("Started new chat");
    } catch (e) {
      log(`New chat reset failed (continuing): ${e.message}`);
    }

    const warnings = [];
    const targetModel = model || DEFAULT_MODEL;
    let selectedModel = targetModel;
    let modelSelectionFailed = false;
        try {
          selectedModel = await selectModel(evalPage, signal, targetModel);
          log(`Model: ${selectedModel}`);
          // K3 / K3 Swarm / agent rows switch kimi.com into the /agent or
          // /projects workspace, which has a different composer this client does
          // not drive. Navigation can lag the click, so poll the URL briefly.
          let urlState = null;
          const urlDeadline = Date.now() + 3500;
          while (Date.now() < urlDeadline) {
            urlState = await evaluate(
              evalPage,
              `(() => ({ url: location.href }))()`,
              signal
            );
            if (urlState && /\/agent|\/swarm|\/projects/.test(urlState.url)) break;
            await delay(250, signal);
          }
          if (urlState && /\/agent|\/swarm|\/projects/.test(urlState.url)) {
        modelSelectionFailed = true;
        warnings.push(
          `Model "${selectedModel}" switches Kimi into its Agent workspace (${urlState.url}); ` +
          `reverting to the default chat model. Use --model instant (default), thinking, or high for the chat UI.`
        );
        selectedModel = DEFAULT_MODEL;
        await evaluate(evalPage, `(() => { location.href = 'https://www.kimi.com/'; return true; })()`, signal).catch(() => {});
        await delay(3500, signal);
        await waitForKimiReady(evalPage, signal);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      modelSelectionFailed = true;
      warnings.push(`Model selection failed: ${e.message}. Kimi may auto-select its default model.`);
      log(`Model selection failed: ${e.message}`);
    }

    await typePrompt(evalPage, signal, prompt);
    log("Prompt typed");

    await submitPrompt(evalPage, signal);
    log("Submitted, waiting for response...");

    const response = await waitForResponse(evalPage, signal, timeout, extractionPrompt);
    log(`Response: ${response.text.length} chars${response.partial ? ' (partial)' : ''}`);

    return {
      response: response.text,
      model: selectedModel,
      requestedModel: targetModel,
      modelSelectionFailed,
      url: response.url,
      partial: response.partial || false,
      warnings: warnings.length > 0 ? warnings : undefined,
      tookMs: Date.now() - startTime,
    };
  } finally {
    try {
      await closeTab(tabId);
    } catch (error) {
      log(`Failed to close Kimi tab ${tabId}: ${error?.message || error}`);
    }
  }
}

// ============================================================================
// Validate - check UI structure and scrape available models
// ============================================================================

async function validate(options) {
  const { createTab, closeTab, jsEval, log = () => {}, signal } = options;
  throwIfAborted(signal);
  const startTime = Date.now();
  log("Starting Kimi validation");

  const result = {
    kimiValidate: true,
    authenticated: false,
    models: [],
    expectedModels: Object.values(DEFAULT_KIMI_MODELS).map((m) => m.name),
    inputFound: false,
    sendButtonFound: false,
    errors: [],
  };

  let tabId;
  try {
    const tabInfo = await raceAbort(createTab, signal);
    tabId = tabInfo && (tabInfo.tabId ?? (tabInfo.tabs && tabInfo.tabs[0] && tabInfo.tabs[0].tabId));
    if (!tabId) {
      result.errors.push(`Failed to create tab: ${JSON.stringify(tabInfo)}`);
      return { ...result, tookMs: Date.now() - startTime };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    result.errors.push(`Tab creation failed: ${e.message}`);
    return { ...result, tookMs: Date.now() - startTime };
  }

  const evalPage = (expression) => raceAbort(() => jsEval(tabId, expression), signal);

  try {
    await raceAbort(waitForPageLoad(evalPage, signal), signal);
    const loginStatus = await checkLoginStatus(evalPage, signal);
    result.authenticated = loginStatus.loggedIn;
    if (!loginStatus.loggedIn) {
      result.errors.push("kimi.com shows logged-out state - log in first");
      return { ...result, tookMs: Date.now() - startTime };
    }

    await raceAbort(waitForKimiReady(evalPage, signal), signal);
    log("Kimi ready");

    const inputCheck = await evaluate(
      evalPage,
      `(() => {
        const input = ${FIND_INPUT_JS};
        return { found: !!input && input.offsetParent !== null };
      })()`,
      signal
    );
    result.inputFound = inputCheck?.found || false;

    const sendCheck = await evaluate(
      evalPage,
      `(() => {
        const container = document.querySelector('.send-button-container');
        if (container && container.offsetParent !== null) return { found: true };
        const input = ${FIND_INPUT_JS};
        const scope = input ? (input.parentElement || document) : document;
        const btn = Array.from(scope.querySelectorAll('button')).find((b) => {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const txt = (b.textContent || '').trim().toLowerCase();
          return label === 'send' || label === 'submit' || label.includes('发送') || txt === 'send';
        });
        return { found: !!btn && btn.offsetParent !== null };
      })()`,
      signal
    );
    result.sendButtonFound = sendCheck?.found || false;

    // Try scraping the model menu
    // Kimi renders .current-model/.model-name late - wait for it (up to 6s)
    let modelReady = false;
    const readyDeadline = Date.now() + 6000;
    while (Date.now() < readyDeadline && !modelReady) {
      const chk = await evaluate(
        evalPage,
        `(() => {
          const el = document.querySelector('.current-model, .model-name');
          return { ready: !!el && el.offsetParent !== null };
        })()`,
        signal
      );
      modelReady = chk && chk.ready;
      if (!modelReady) await abortableDelay(400, signal);
    }

    const modelClicked = await evaluate(
      evalPage,
      `(() => {
        ${buildClickDispatcher()}
        const modelDiv = document.querySelector('.current-model, .model-name, [class*="model-picker"], [class*="model-select"]');
        if (modelDiv && modelDiv.offsetParent !== null) {
          dispatchClickSequence(modelDiv);
          return { success: true };
        }
        const input = ${FIND_INPUT_JS};
        const scope = input ? (input.parentElement || document) : document;
        const btn = Array.from(scope.querySelectorAll('button')).find((b) => {
          const text = (b.textContent || '').toLowerCase();
          return /k2|k3|instant|thinking|model/i.test(text);
        });
        if (btn) { dispatchClickSequence(btn); return { success: true }; }
        return { success: false };
      })()`,
      signal
    );

    if (modelClicked?.success) {
      // Popover may take a moment - retry the scrape for up to ~4s
      let scrapeResult = null;
      const scrapeDeadline = Date.now() + 4000;
      while (Date.now() < scrapeDeadline && !(scrapeResult && scrapeResult.models && scrapeResult.models.length > 0)) {
        await abortableDelay(600, signal);
        scrapeResult = await evaluate(
          evalPage,
          `(() => {
            const popover = document.querySelector('.models-popover') ||
              Array.from(document.querySelectorAll('.n-popover__content, .n-popover')).find((el) => el.offsetParent !== null && (el.textContent || '').length > 0);
            if (!popover) return { models: [] };
            const names = [];
            const seen = new Set();
            for (const el of popover.querySelectorAll('[class*="item"], div')) {
              const first = (el.textContent || '').trim().split('\\n')[0].trim();
              if (!first || first.length < 1 || first.length > 40 || seen.has(first)) continue;
              seen.add(first);
              names.push(first);
            }
            return { models: names.slice(0, 12) };
          })()`,
          signal
        ).catch(() => ({ models: [] }));
      }
      result.models = scrapeResult?.models || [];
      log(`Found models: ${result.models.join(', ')}`);
      await evaluate(evalPage, "document.body.click()", signal);
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    result.errors.push(`Validation error: ${e.message}`);
  } finally {
    try {
      await closeTab(tabId);
    } catch (error) {
      log(`Failed to close Kimi validation tab ${tabId}: ${error?.message || error}`);
    }
  }

  result.tookMs = Date.now() - startTime;
  return result;
}

    module.exports = {
            query,
            validate,
            extractKimiResponse,
            normalizeLabel,
            getMatchLabels,
            waitForResponse,
            KIMI_URL,
            DEFAULT_KIMI_MODELS,
            DEFAULT_MODEL,
            };
