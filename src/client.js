import {
  buildPromptMessages,
  findIllustratorMessage,
  findSelfieCharacterName,
  findImageByUrl,
  parseGeneration,
  parsePromptResult,
  record,
  resolvePromptConfiguration,
  trimmed,
} from './core.mjs';

const ACTIVE_CHAT_KEY = 'marinara-active-chat-id';
const UI_STORAGE_KEYS = ['marinara-engine-ui:host', 'marinara-engine-ui'];
let active = null;
let scanQueued = false;
let stopped = false;

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json', 'x-marinara-csrf': '1' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Marinara request failed (${response.status}).`);
  return data;
}

function readUiState() {
  for (const key of UI_STORAGE_KEYS) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      if (saved?.state && typeof saved.state === 'object') return saved.state;
    } catch { /* The other key may be valid. */ }
  }
  return {};
}

function elementsForDialog(dialog) {
  const picture = dialog.querySelector('img[src*="/api/gallery/file/"]');
  if (!picture) return null;
  for (const connectionControl of dialog.querySelectorAll('select, button[data-connection-value][aria-haspopup="dialog"]')) {
    const connectionLabel = connectionControl.closest('label');
    const form = connectionLabel?.parentElement;
    if (!form) continue;
    const labels = [...form.children].filter((item) => item.matches?.('label'));
    const fields = labels.filter((item) => item.querySelector('textarea'));
    if (fields.length < 2) continue;
    const footer = [...form.children].findLast((item) => item.querySelectorAll?.('button').length >= 2);
    const nativeGenerate = footer?.querySelector('button:last-of-type');
    if (!footer || !nativeGenerate) continue;
    return {
      dialog, picture, form, connectionLabel, promptLabel: fields[0],
      negativeLabel: fields[1], prompt: fields[0].querySelector('textarea'),
      negative: fields[1].querySelector('textarea'), connectionControl, footer, nativeGenerate,
    };
  }
  return null;
}

function cleanup() {
  if (!active) return;
  active.controller.abort();
  for (const dispose of active.disposers || []) dispose();
  for (const node of active.nodes || []) node.remove();
  active = null;
}

function setNativeText(field, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('This browser cannot update Marinara’s prompt fields.');
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function status(state, message, isError = false) {
  state.status.textContent = message;
  state.status.classList.toggle('image-regen-error', isError);
}

function busy(state, value) {
  state.busy = value;
  const disabled = value || state.nativeGenerate.disabled;
  state.promptButton.disabled = disabled;
  state.bothButton.disabled = disabled;
  state.guidance.disabled = disabled;
  for (const button of state.resetButtons) button.disabled = disabled;
}

async function promptRequest(state) {
  const chatId = encodeURIComponent(state.image.chatId);
  const [chat, agents, manifests, connections] = await Promise.all([
    request(`/api/chats/${chatId}`, { signal: state.controller.signal }),
    request('/api/agents', { signal: state.controller.signal }),
    request('/api/capability-packages/agents', { signal: state.controller.signal }),
    request('/api/connections', { signal: state.controller.signal }),
  ]);
  const agent = Array.isArray(agents) ? agents.find((item) => item.type === 'illustrator') : null;
  const manifest = Array.isArray(manifests) ? manifests.find((item) => item.id === 'illustrator') : null;
  if (!agent || !manifest) throw new Error('Install and configure the Illustrator agent first.');
  const connectionControl = state.elements.connectionControl;
  const selectedImageConnectionId = trimmed(
    connectionControl.matches('select') ? connectionControl.value : connectionControl.dataset.connectionValue,
  ) || state.original.connectionId;
  let rows = Array.isArray(connections) ? connections : [];
  if (selectedImageConnectionId) {
    const detail = await request(`/api/connections/${encodeURIComponent(selectedImageConnectionId)}`, {
      signal: state.controller.signal,
    });
    rows = [...rows.filter((item) => item.id !== selectedImageConnectionId), detail];
  }
  const characterIds = Array.isArray(chat.characterIds) ? chat.characterIds.slice(0, 12) : [];
  const [characters, persona, selfiePromptOverride] = await Promise.all([
    Promise.all(characterIds.map((id) =>
      request(`/api/characters/${encodeURIComponent(id)}`, { signal: state.controller.signal }).catch(() => null)
    )),
    trimmed(chat.personaId)
      ? request(`/api/personas/${encodeURIComponent(chat.personaId)}`, { signal: state.controller.signal }).catch(() => null)
      : Promise.resolve(null),
    chat.mode === 'conversation'
      ? request('/api/prompt-overrides/conversation.selfie', { signal: state.controller.signal })
      : Promise.resolve(null),
  ]);
  const selfieCharacter = chat.mode === 'conversation'
    ? characters.filter(Boolean).find((character) => {
      const data = record(character.data);
      return trimmed(data.name || character.name).toLowerCase() === state.selfieCharacterName.toLowerCase();
    }) || (characters.filter(Boolean).length === 1 ? characters.find(Boolean) : null)
    : null;
  const configuration = resolvePromptConfiguration({
    chat, agent, manifest, connections: rows, selectedImageConnectionId, uiState: readUiState(),
    selfiePromptOverride, selfieCharacter, selfieCharacterName: state.selfieCharacterName,
  });
  const messages = buildPromptMessages({
    configuration, original: state.original, guidance: state.guidance.value,
    messages: state.messages, sourceMessageId: state.sourceMessage?.id,
    characters: characters.filter(Boolean), persona, chatId: chat.id,
  });
  const body = {
    connectionId: configuration.promptConnectionId,
    messages,
    parameters: { temperature: 0.55, maxTokens: configuration.maxTokens },
    streaming: false,
  };
  const raw = await request('/api/generate/raw', { method: 'POST', body, signal: state.controller.signal });
  try {
    return parsePromptResult(raw.content);
  } catch (firstError) {
    const repair = await request('/api/generate/raw', {
      method: 'POST',
      body: {
        ...body,
        messages: [...messages,
          { role: 'assistant', content: String(raw.content || '').slice(0, 7000) },
          { role: 'user', content: 'Return exactly [[MARINARA_PROMPT]], the complete nonempty revised image prompt, [[MARINARA_NEGATIVE_PROMPT]], the revised negative prompt (which may be empty), and [[MARINARA_END]]. Keep any JSON inside the image prompt as plain text between the markers. Add no other text.' },
        ],
      },
      signal: state.controller.signal,
    });
    return parsePromptResult(repair.content);
  }
}

async function runPrompt(state, withImage) {
  if (state.busy || state.nativeGenerate.disabled || !state.elements.form.isConnected) return;
  busy(state, true);
  status(state, 'Generating prompt…');
  let previousValues = null;
  let handedOff = false;
  try {
    const result = await promptRequest(state);
    if (state.controller.signal.aborted || !state.elements.form.isConnected) return;
    previousValues = [state.elements.prompt.value, state.elements.negative.value];
    setNativeText(state.elements.prompt, result.prompt);
    setNativeText(state.elements.negative, result.negativePrompt);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (state.elements.prompt.value !== result.prompt || state.elements.negative.value !== result.negativePrompt) {
      throw new Error('Marinara did not accept the revised prompt fields.');
    }
    if (withImage) {
      status(state, 'Prompt ready. Generating image…');
      busy(state, false);
      state.nativeGenerate.click();
      handedOff = true;
    } else {
      status(state, 'Prompt ready. Review the fields or generate the image.');
    }
  } catch (error) {
    if (!state.controller.signal.aborted) {
      if (previousValues && !handedOff && state.elements.form.isConnected) {
        setNativeText(state.elements.prompt, previousValues[0]);
        setNativeText(state.elements.negative, previousValues[1]);
      }
      status(state, error?.message || 'Prompt generation failed.', true);
    }
  } finally {
    if (!state.controller.signal.aborted && state.elements.form.isConnected) busy(state, false);
  }
}

function makeButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function makeGenerateButton(label, nativeGenerate) {
  const button = makeButton(label, `${nativeGenerate.className} image-regen-action`);
  const icon = nativeGenerate.querySelector('svg');
  if (icon) button.prepend(icon.cloneNode(true));
  return button;
}

function mount(state) {
  const elements = state.elements;
  const nodes = [];
  const resetButtons = [];
  for (const [label, field, initial] of [
    [elements.promptLabel, elements.prompt, state.original.prompt],
    [elements.negativeLabel, elements.negative, state.original.negativePrompt],
  ]) {
    const button = makeButton('Reset to original', 'image-regen-reset');
    button.setAttribute('aria-label', `Reset ${label.querySelector('span')?.textContent || 'prompt'} to original`);
    button.addEventListener('click', () => setNativeText(field, initial));
    const heading = label.querySelector('span') || label;
    heading.appendChild(button);
    nodes.push(button);
    resetButtons.push(button);
  }
  const guidanceLabel = document.createElement('label');
  guidanceLabel.className = 'image-regen-guidance';
  const title = document.createElement('span');
  title.textContent = 'AI guidance';
  const guidance = document.createElement('textarea');
  guidance.rows = 3;
  guidance.placeholder = 'Describe how to change the original prompt…';
  guidance.setAttribute('aria-label', 'AI guidance');
  guidanceLabel.append(title, guidance);
  elements.connectionLabel.after(guidanceLabel);
  nodes.push(guidanceLabel);
  const feedback = document.createElement('p');
  feedback.className = 'image-regen-status';
  feedback.setAttribute('role', 'status');
  guidanceLabel.after(feedback);
  nodes.push(feedback);
  const promptButton = makeGenerateButton('Generate Prompt', elements.nativeGenerate);
  const bothButton = makeGenerateButton('Generate', elements.nativeGenerate);
  bothButton.classList.add('image-regen-both');
  promptButton.addEventListener('click', () => void runPrompt(state, false));
  bothButton.addEventListener('click', () => void runPrompt(state, true));
  elements.nativeGenerate.before(promptButton);
  elements.nativeGenerate.after(bothButton);
  elements.nativeGenerate.classList.add('image-regen-native');
  elements.footer.classList.add('image-regen-footer');
  nodes.push(promptButton, bothButton);
  const guardNativeClick = (event) => {
    if (!state.busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  elements.nativeGenerate.addEventListener('click', guardNativeClick, true);
  const nativeStateObserver = new MutationObserver(() => {
    const nativeIcon = elements.nativeGenerate.querySelector('svg');
    for (const button of [state.promptButton, state.bothButton]) {
      button.className = `${elements.nativeGenerate.className.replace(/\bimage-regen-native\b/g, '').trim()} image-regen-action`;
      const currentIcon = button.querySelector('svg');
      if (nativeIcon) {
        if (currentIcon) currentIcon.replaceWith(nativeIcon.cloneNode(true));
        else button.prepend(nativeIcon.cloneNode(true));
      } else {
        currentIcon?.remove();
      }
    }
    state.bothButton.classList.add('image-regen-both');
    busy(state, state.busy);
  });
  nativeStateObserver.observe(elements.nativeGenerate, {
    attributes: true, attributeFilter: ['disabled', 'class'], childList: true,
  });
  Object.assign(state, {
    nodes, resetButtons, status: feedback, guidance, promptButton, bothButton,
    nativeGenerate: elements.nativeGenerate,
    disposers: [
      () => elements.nativeGenerate.removeEventListener('click', guardNativeClick, true),
      () => nativeStateObserver.disconnect(),
      () => elements.nativeGenerate.classList.remove('image-regen-native'),
      () => elements.footer.classList.remove('image-regen-footer'),
    ],
  });
}

async function inspect(elements) {
  const controller = new AbortController();
  const state = { elements, controller, nodes: [], busy: false };
  active = state;
  try {
    const activeChatId = trimmed(localStorage.getItem(ACTIVE_CHAT_KEY));
    if (!activeChatId) return;
    const gallery = await request(`/api/gallery/${encodeURIComponent(activeChatId)}`, { signal: controller.signal });
    const image = findImageByUrl(gallery, elements.picture.src);
    if (!image) return;
    const chat = await request(`/api/chats/${encodeURIComponent(image.chatId)}`, { signal: controller.signal });
    if (!['conversation', 'roleplay', 'game'].includes(chat.mode)) return;
    const messages = await request(`/api/chats/${encodeURIComponent(image.chatId)}/messages`, { signal: controller.signal });
    const sourceMessage = findIllustratorMessage(messages, image.id, chat.mode);
    const savedGeneration = record(image.generation);
    if (!sourceMessage && !(chat.mode === 'conversation' && savedGeneration.version === 1 && trimmed(savedGeneration.prompt))) return;
    if (controller.signal.aborted || !elements.form.isConnected) return;
    state.image = image;
    state.messages = messages;
    state.sourceMessage = sourceMessage;
    state.selfieCharacterName = chat.mode === 'conversation' ? findSelfieCharacterName(sourceMessage, image.id) : '';
    state.original = parseGeneration(image);
    mount(state);
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[Image Regen] Could not inspect the selected image:', error);
  }
}

function scan() {
  scanQueued = false;
  if (stopped) return;
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"][data-chat-floating-panel]');
  const candidate = [...dialogs].map(elementsForDialog).find(Boolean);
  if (!candidate) {
    cleanup();
    return;
  }
  if (active?.elements.form === candidate.form) return;
  cleanup();
  void inspect(candidate);
}

function queueScan() {
  if (scanQueued || stopped) return;
  scanQueued = true;
  queueMicrotask(scan);
}

const observer = new MutationObserver(queueScan);
observer.observe(document.body, { childList: true, subtree: true });
queueScan();
marinara.onCleanup(() => {
  stopped = true;
  observer.disconnect();
  cleanup();
});
