import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPromptMessages,
  findIllustratorMessage,
  findSelfieCharacterName,
  findImageByUrl,
  parseGeneration,
  parsePromptResult,
  renderTemplateMacros,
  resolveIllustratorTemplate,
  resolveConversationSelfieTemplate,
  resolvePromptConfiguration,
} from '../src/core.mjs';

test('resolves the chat-selected Illustrator template and prompt model', () => {
  const metadata = { illustratorPromptConnectionId: 'writer', agentPromptTemplateIds: { illustrator: 'comic' }, imageStyleProfileId: 'film' };
  const agent = { settings: { promptTemplates: [{ id: 'comic', promptTemplate: 'Comic layout' }] } };
  const manifest = { defaultPromptTemplate: 'Default layout', defaultSettings: {} };
  assert.equal(resolveIllustratorTemplate(metadata, agent, manifest), 'Comic layout');
  const config = resolvePromptConfiguration({
    chat: { mode: 'roleplay', connectionId: 'chat-model', metadata }, agent, manifest,
    connections: [
      { id: 'writer', provider: 'openai' },
      { id: 'image', provider: 'image_generation', imagePromptInstructions: 'Use SDXL framing.' },
    ],
    selectedImageConnectionId: 'image',
    uiState: { imageStyleProfiles: { defaultProfileId: 'auto', profiles: [{ id: 'film', styleText: 'Film still' }] } },
  });
  assert.equal(config.promptConnectionId, 'writer');
  assert.equal(config.template, 'Comic layout');
  assert.equal(config.styleInstruction, 'Film still');
  assert.equal(config.imagePromptInstructions, 'Use SDXL framing.');
});

test('renders Illustrator setting and chat macros without interpreting unknown tokens', () => {
  assert.equal(
    renderTemplateMacros('Style {{style.name}} for {{char}} and {{user}}; keep {{unknown}}.',
      { style: { name: 'black & white' } }, { char: 'Alice', user: 'Pat' }),
    'Style black &amp; white for Alice and Pat; keep {{unknown}}.',
  );
});

test('keeps saved provider prompt separate from the gallery display prompt', () => {
  const saved = parseGeneration({
    prompt: 'Display prompt | character caption',
    generation: JSON.stringify({ version: 1, prompt: 'Saved request', negativePrompt: 'blur', connectionId: 'image' }),
  });
  assert.deepEqual(saved, { prompt: 'Saved request', negativePrompt: 'blur', connectionId: 'image' });
  assert.deepEqual(parseGeneration({ prompt: 'Older image', generation: null }), {
    prompt: 'Older image', negativePrompt: '', connectionId: '',
  });
});

test('identifies only Illustrator attachments and matches gallery URLs', () => {
  const row = { id: 'pic', url: '/api/gallery/file/chat/pic.png' };
  assert.equal(findImageByUrl([row], 'http://localhost/api/gallery/file/chat/pic.png?x=1'), row);
  const messages = [
    { id: 'story', role: 'assistant', extra: { attachments: [{ type: 'image', galleryId: 'pic', filename: 'storyboard.png' }] } },
    { id: 'illustration', role: 'assistant', extra: JSON.stringify({ attachments: [{ type: 'image', galleryId: 'pic', filename: 'illustration_1.png' }] }) },
  ];
  assert.equal(findIllustratorMessage(messages, 'pic')?.id, 'illustration');
  assert.equal(findIllustratorMessage(messages.slice(0, 1), 'pic'), null);
});

test('identifies Conversation selfie attachments and their character', () => {
  const messages = [
    { id: 'scene', role: 'assistant', extra: { attachments: [{ type: 'image', galleryId: 'scene', filename: 'illustration_1.png' }] } },
    { id: 'selfie', role: 'assistant', extra: { attachments: [{ type: 'image', galleryId: 'photo', filename: 'selfie_alex_1.png', characterName: 'Alex' }] } },
  ];
  assert.equal(findIllustratorMessage(messages, 'photo', 'conversation')?.id, 'selfie');
  assert.equal(findSelfieCharacterName(messages[1], 'photo'), 'Alex');
  assert.equal(findIllustratorMessage(messages, 'scene', 'conversation'), null);
});

test('Conversation prompt configuration uses the selfie connection and template', () => {
  const chat = {
    mode: 'conversation', connectionId: 'text',
    metadata: { imageGenConnectionId: 'selfie-image', selfiePrompt: 'Photo of ${charName}: ${appearance}', selfieNegativePrompt: 'blur' },
  };
  const character = { data: { name: 'Alex', description: 'dark hair' } };
  const config = resolvePromptConfiguration({
    chat, agent: {}, manifest: { defaultPromptTemplate: 'RP scene' },
    connections: [{ id: 'text', provider: 'openai' }, { id: 'selfie-image', provider: 'image_generation' }],
    selectedImageConnectionId: '', uiState: {}, selfieCharacter: character, selfieCharacterName: 'Alex',
  });
  assert.equal(config.imageConnectionId, 'selfie-image');
  assert.equal(config.template, 'Photo of Alex: dark hair');
  assert.equal(config.negativePromptInstruction, 'blur');
  assert.equal(resolveConversationSelfieTemplate({}, {
    override: { enabled: true, template: 'Portrait of ${charName}: ${appearance}' },
  }, character, 'Alex'), 'Portrait of Alex: dark hair');
  assert.match(resolveConversationSelfieTemplate({}, null, {
    data: { name: 'Alex', description: 'dark hair', extensions: {
      imageAppearanceEnabled: true, imageAppearance: 'exact-style-token',
    } },
  }, 'Alex'), /Preserve every tag and identifier verbatim/);
});

test('the built-in local Prompt Model is valid without a connection row', () => {
  const config = resolvePromptConfiguration({
    chat: { mode: 'conversation', connectionId: '__local_sidecar__', metadata: { imageGenConnectionId: 'image' } },
    agent: {}, manifest: {},
    connections: [{ id: 'image', provider: 'image_generation' }],
    selectedImageConnectionId: '', uiState: {},
  });
  assert.equal(config.promptConnectionId, '__local_sidecar__');
  const unknown = resolvePromptConfiguration({
    chat: { mode: 'conversation', connectionId: 'unlisted-text-model', metadata: { imageGenConnectionId: 'image' } },
    agent: {}, manifest: {}, connections: [{ id: 'image', provider: 'image_generation' }],
    selectedImageConnectionId: '', uiState: {},
  });
  assert.equal(unknown.promptConnectionId, 'unlisted-text-model');
  assert.throws(() => resolvePromptConfiguration({
    chat: { mode: 'conversation', connectionId: 'image', metadata: { imageGenConnectionId: 'image' } },
    agent: {}, manifest: {}, connections: [{ id: 'image', provider: 'image_generation' }],
    selectedImageConnectionId: '', uiState: {},
  }), /not a text connection/);
});

test('appends saved prompt and guidance after historical context', () => {
  const result = buildPromptMessages({
    configuration: { template: 'Portrait mode', styleInstruction: '', imagePromptInstructions: '', contextSize: 2 },
    original: { prompt: 'A woman in a kitchen', negativePrompt: 'watermark' },
    guidance: 'Change her coat to red',
    messages: [
      { id: '1', role: 'user', content: 'winter morning' },
      { id: '2', role: 'assistant', content: 'She enters the kitchen' },
      { id: '3', role: 'assistant', content: 'later unrelated scene' },
    ],
    sourceMessageId: '2',
  });
  assert.equal(result.length, 4);
  assert.match(result[0].content, /Portrait mode/);
  assert.doesNotMatch(result.at(-1).content, /later unrelated scene/);
  assert.match(result.at(-1).content, /Original Prompt:\nA woman in a kitchen/);
  assert.match(result.at(-1).content, /Change her coat to red/);
});

test('accepts valid prompt JSON and rejects incomplete output', () => {
  assert.deepEqual(parsePromptResult('```json\n{"prompt":"new","negativePrompt":""}\n```'), {
    prompt: 'new', negativePrompt: '',
  });
  assert.throws(() => parsePromptResult('{"prompt":"new"}'), /incomplete/);
  assert.throws(() => parsePromptResult('not JSON'), /two prompt fields/);
});

test('accepts marked fields when the image prompt contains nested JSON text', () => {
  assert.deepEqual(parsePromptResult(
    '[[MARINARA_PROMPT]]\ncinematic scene {"style":"realistic","light":"soft"}\n[[MARINARA_NEGATIVE_PROMPT]]\nblurry\n[[MARINARA_END]]',
  ), {
    prompt: 'cinematic scene {"style":"realistic","light":"soft"}',
    negativePrompt: 'blurry',
  });
  assert.deepEqual(parsePromptResult(
    '[[MARINARA_PROMPT]]\nportrait\n[[MARINARA_NEGATIVE_PROMPT]]\n[[MARINARA_END]]',
  ), { prompt: 'portrait', negativePrompt: '' });
});
