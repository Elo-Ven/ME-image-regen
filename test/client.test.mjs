import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/client.js', import.meta.url))],
  bundle: true, format: 'iife', target: 'es2022', write: false,
});
const script = built.outputFiles[0].text;

function dialogHtml(url = '/api/gallery/file/chat1/old.png', { connectionPicker = false, connectionId = 'image' } = {}) {
  return `<div role="dialog" aria-modal="true" data-chat-floating-panel>
    <img src="${url}">
    <div id="form">
      <label><span>Prompt</span><textarea>old prompt</textarea></label>
      <label><span>Negative prompt</span><textarea>old negative</textarea></label>
      <label><span>Image connection</span>${connectionPicker
        ? `<button type="button" aria-haspopup="dialog" aria-expanded="false" data-connection-value="${connectionId}">Image</button>`
        : `<select><option value="${connectionId}">${connectionId}</option></select>`}</label>
      <p>References notice</p>
      <div><button type="button">Cancel</button><button type="button" id="image-only" class="native-generate"><svg class="lucide-refresh-cw" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9"/></svg>Generate image</button></div>
    </div>
  </div>`;
}

async function setup({ oldRecord = true, rawResult = { prompt: 'revised prompt', negativePrompt: 'revised negative' }, missingPromptModel = false, localPromptModel = false, eligible = true, mode = 'roleplay', galleryOnly = false, connectionPicker = false, connectionId = 'image' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${dialogHtml(undefined, { connectionPicker, connectionId })}</body></html>`, {
    url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.localStorage.setItem('marinara-active-chat-id', 'chat1');
  const calls = [];
  const imageOnly = window.document.querySelector('#image-only');
  imageOnly.addEventListener('click', () => calls.push({ path: 'native-image', prompt: window.document.querySelectorAll('#form textarea')[0].value }));
  const gallery = [{
    id: 'old', chatId: 'chat1', url: '/api/gallery/file/chat1/old.png', prompt: 'display prompt',
    generation: oldRecord ? JSON.stringify({ version: 1, prompt: 'old prompt', negativePrompt: 'old negative', connectionId: 'image' }) : null,
  }];
  const messages = galleryOnly ? [] : [{
    id: 'message1', role: 'assistant', content: 'A cold morning',
    extra: { attachments: [{ type: 'image', galleryId: 'old', filename: eligible
      ? mode === 'conversation' ? 'selfie_alex_1.png' : 'illustration_1.png'
      : 'storyboard.png', characterName: 'Alex' }] },
  }];
  const chat = { id: 'chat1', mode, connectionId: missingPromptModel ? null : localPromptModel ? '__local_sidecar__' : 'text',
    characterIds: mode === 'conversation' ? ['char1'] : [],
    metadata: mode === 'conversation' ? {
      imageGenConnectionId: 'image', selfiePrompt: 'Selfie of ${charName}: ${appearance}. ${characterImageInstructions}',
      selfieNegativePrompt: 'watermark',
    } : {},
  };
  window.fetch = async (path, options = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    let data;
    if (path === '/api/gallery/chat1') data = gallery;
    else if (path === '/api/chats/chat1') data = chat;
    else if (path === '/api/chats/chat1/messages') data = messages;
    else if (path === '/api/agents') data = [{ type: 'illustrator', promptTemplate: '', settings: {} }];
    else if (path === '/api/capability-packages/agents') data = [{ id: 'illustrator', defaultPromptTemplate: 'Illustrator visual rules' }];
    else if (path === '/api/connections') data = [{ id: 'text', provider: 'openai' }, { id: 'image', provider: 'image_generation' }, { id: 'alternate-image', provider: 'image_generation' }];
    else if (path === '/api/connections/image' || path === '/api/connections/alternate-image') data = { id: path.split('/').at(-1), provider: 'image_generation', imagePromptInstructions: 'ComfyUI guidance' };
    else if (path === '/api/characters/char1') data = { id: 'char1', data: { name: 'Alex', description: 'short dark hair', extensions: { conversationImageInstructions: 'Candid framing' } } };
    else if (path === '/api/prompt-overrides/conversation.selfie') data = { key: 'conversation.selfie', override: null };
    else if (path === '/api/generate/raw') {
      const result = Array.isArray(rawResult)
        ? rawResult[calls.filter((call) => call.path === path).length - 1]
        : rawResult;
      data = { content: typeof result === 'string' ? result : JSON.stringify(result) };
    }
    else return new Response(JSON.stringify({ error: 'Unexpected path' }), { status: 404 });
    return new Response(JSON.stringify(data), { status: 200 });
  };
  let cleanup;
  window.marinara = { onCleanup(callback) { cleanup = callback; } };
  window.eval(script);
  await until(() => !eligible || window.document.querySelector('.image-regen-guidance'));
  return { window, calls, gallery, messages, chat, cleanup: () => { cleanup?.(); window.close(); } };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for extension UI');
}

test('prompt-only changes fields, resets independently, and leaves image-only action native', async () => {
  const app = await setup();
  try {
    const { window, calls } = app;
    const fields = window.document.querySelectorAll('#form > label textarea');
    window.document.querySelector('.image-regen-guidance textarea').value = 'Make the coat red';
    window.document.querySelector('.image-regen-action').click();
    await until(() => fields[0].value === 'revised prompt');
    await until(() => !window.document.querySelector('.image-regen-reset').disabled);
    assert.equal(fields[1].value, 'revised negative');
    assert.equal(calls.filter((call) => call.path === 'native-image').length, 0);
    assert.match(calls.find((call) => call.path === '/api/generate/raw').body.messages.at(-1).content, /Make the coat red/);
    window.document.querySelectorAll('.image-regen-reset')[0].click();
    assert.equal(fields[0].value, 'old prompt');
    assert.equal(fields[1].value, 'revised negative');
    window.document.querySelector('#image-only').click();
    assert.equal(calls.filter((call) => call.path === 'native-image').length, 1);
  } finally { app.cleanup(); }
});

test('v2.5.2 connection picker mounts controls and uses its selected image model', async () => {
  const app = await setup({ connectionPicker: true, connectionId: 'alternate-image' });
  try {
    const document = app.window.document;
    assert.equal(document.querySelector('#form select'), null);
    assert.ok(document.querySelector('.image-regen-guidance'));
    document.querySelector('.image-regen-action').click();
    await until(() => app.calls.some((call) => call.path === '/api/generate/raw'));
    assert.ok(app.calls.some((call) => call.path === '/api/connections/alternate-image'));
    assert.equal(app.calls.some((call) => call.path === '/api/connections/image'), false);
    assert.match(app.calls.find((call) => call.path === '/api/generate/raw').body.messages[0].content, /ComfyUI guidance/);
  } finally { app.cleanup(); }
});

test('generate controls use native icon and styling in the requested order', async () => {
  const app = await setup();
  try {
    const footer = app.window.document.querySelector('#image-only').parentElement;
    const buttons = [...footer.querySelectorAll('button')];
    assert.deepEqual(buttons.map((button) => button.textContent), [
      'Cancel', 'Generate Prompt', 'Generate image', 'Generate',
    ]);
    for (const button of buttons.slice(1)) {
      assert.ok(button.classList.contains('native-generate'));
      assert.ok(button.querySelector('svg.lucide-refresh-cw'));
    }
    assert.ok(buttons[2].classList.contains('image-regen-native'));
    buttons[2].classList.add('native-busy');
    await until(() => buttons[1].classList.contains('native-busy'));
    assert.ok(buttons[3].classList.contains('native-busy'));
  } finally { app.cleanup(); }
});

test('combined Generate waits for the prompt and passes it to the native image action', async () => {
  const app = await setup();
  try {
    app.window.document.querySelector('.image-regen-both').click();
    await until(() => app.calls.some((call) => call.path === 'native-image'));
    assert.equal(app.calls.find((call) => call.path === 'native-image').prompt, 'revised prompt');
    assert.ok(app.calls.findIndex((call) => call.path === '/api/generate/raw') < app.calls.findIndex((call) => call.path === 'native-image'));
  } finally { app.cleanup(); }
});

test('marked prompt output updates the existing fields', async () => {
  const app = await setup({
    rawResult: '[[MARINARA_PROMPT]]\nscene {"lighting":"warm"}\n[[MARINARA_NEGATIVE_PROMPT]]\nblur\n[[MARINARA_END]]',
  });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    const fields = app.window.document.querySelectorAll('#form > label textarea');
    await until(() => fields[0].value === 'scene {"lighting":"warm"}');
    assert.equal(fields[1].value, 'blur');
    assert.equal(app.calls.filter((call) => call.path === '/api/generate/raw').length, 1);
  } finally { app.cleanup(); }
});

test('Conversation selfie from a message uses its chat selfie guidance', async () => {
  const app = await setup({ mode: 'conversation' });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    await until(() => app.window.document.querySelector('#form > label textarea').value === 'revised prompt');
    const raw = app.calls.find((call) => call.path === '/api/generate/raw').body;
    assert.match(raw.messages[0].content, /Selfie of Alex: short dark hair\. Candid framing/);
    assert.match(raw.messages[0].content, /Conversation selfie negative prompt guidance: watermark/);
    assert.equal(app.calls.filter((call) => call.path === 'native-image').length, 0);
  } finally { app.cleanup(); }
});

test('Conversation selfie accepts the built-in local Prompt Model without a saved connection row', async () => {
  const app = await setup({ mode: 'conversation', localPromptModel: true });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    await until(() => app.window.document.querySelector('#form > label textarea').value === 'revised prompt');
    const raw = app.calls.find((call) => call.path === '/api/generate/raw');
    assert.equal(raw.body.connectionId, '__local_sidecar__');
    assert.equal(app.window.document.querySelector('.image-regen-error'), null);
  } finally { app.cleanup(); }
});

test('Conversation gallery-only selfie with a saved request has regeneration controls', async () => {
  const app = await setup({ mode: 'conversation', galleryOnly: true });
  try {
    app.window.document.querySelector('.image-regen-both').click();
    await until(() => app.calls.some((call) => call.path === 'native-image'));
    assert.equal(app.calls.find((call) => call.path === 'native-image').prompt, 'revised prompt');
  } finally { app.cleanup(); }
});

test('Conversation image without a selfie attachment or saved request stays untouched', async () => {
  const app = await setup({ mode: 'conversation', oldRecord: false, eligible: false });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(app.window.document.querySelector('.image-regen-guidance'), null);
  } finally { app.cleanup(); }
});

test('Game illustration still supports prompt-only regeneration', async () => {
  const app = await setup({ mode: 'game' });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    await until(() => app.window.document.querySelector('#form > label textarea').value === 'revised prompt');
    assert.equal(app.calls.filter((call) => call.path === 'native-image').length, 0);
  } finally { app.cleanup(); }
});

test('repairs an invalid first response with marked fields', async () => {
  const app = await setup({ rawResult: [
    'unescaped {"scene":"inside prompt"}',
    '[[MARINARA_PROMPT]]\nrepaired scene\n[[MARINARA_NEGATIVE_PROMPT]]\nblur\n[[MARINARA_END]]',
  ] });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    await until(() => app.window.document.querySelector('#form > label textarea').value === 'repaired scene');
    assert.equal(app.calls.filter((call) => call.path === '/api/generate/raw').length, 2);
  } finally { app.cleanup(); }
});

test('invalid AI output and missing prompt connection never start image generation', async () => {
  for (const options of [{ rawResult: 'bad output' }, { missingPromptModel: true }]) {
    const app = await setup(options);
    try {
      app.window.document.querySelector('.image-regen-both').click();
      await until(() => app.window.document.querySelector('.image-regen-error'));
      assert.equal(app.calls.filter((call) => call.path === 'native-image').length, 0);
      assert.equal(app.window.document.querySelector('#form textarea').value, 'old prompt');
    } finally { app.cleanup(); }
  }
});

test('older saved images use their visible prompt and a blank guidance fallback', async () => {
  const app = await setup({ oldRecord: false });
  try {
    app.window.document.querySelector('.image-regen-action').click();
    await until(() => app.calls.some((call) => call.path === '/api/generate/raw'));
    const request = app.calls.find((call) => call.path === '/api/generate/raw').body;
    assert.match(request.messages.at(-1).content, /Original Prompt:\ndisplay prompt/);
    assert.match(request.messages.at(-1).content, /faithful alternate wording/);
  } finally { app.cleanup(); }
});

test('does not add controls to an unverified gallery image', async () => {
  const app = await setup({ eligible: false });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(app.window.document.querySelector('.image-regen-guidance'), null);
  } finally { app.cleanup(); }
});

test('a replacement image supplies the next original prompts and cleanup removes controls', async () => {
  const app = await setup();
  try {
    app.gallery.push({
      id: 'new', chatId: 'chat1', url: '/api/gallery/file/chat1/new.png', prompt: 'new display',
      generation: JSON.stringify({ version: 1, prompt: 'new original', negativePrompt: 'new exclusion', connectionId: 'image' }),
    });
    app.messages.push({
      id: 'message2', role: 'assistant', content: 'Another illustration',
      extra: { attachments: [{ type: 'image', galleryId: 'new', filename: 'illustration_1.png' }] },
    });
    app.window.document.querySelector('[role="dialog"]').remove();
    app.window.document.body.insertAdjacentHTML('beforeend', dialogHtml('/api/gallery/file/chat1/new.png'));
    await until(() => app.window.document.querySelector('.image-regen-guidance'));
    const fields = app.window.document.querySelectorAll('#form > label textarea');
    fields[0].value = 'manual edit';
    fields[1].value = 'manual exclusion';
    app.window.document.querySelectorAll('.image-regen-reset')[0].click();
    app.window.document.querySelectorAll('.image-regen-reset')[1].click();
    assert.equal(fields[0].value, 'new original');
    assert.equal(fields[1].value, 'new exclusion');
    const document = app.window.document;
    app.cleanup();
    assert.equal(document.querySelector('.image-regen-guidance'), null);
  } finally { app.cleanup(); }
});
