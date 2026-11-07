export function record(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function templateId(value) {
  return trimmed(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/(^-|-$)/g, '');
}

function templateOptions(value) {
  const entries = Array.isArray(value) ? value : Object.entries(record(value)).map(([id, option]) => ({ ...record(option), id }));
  return entries.map((entry) => ({
    id: templateId(entry?.id),
    promptTemplate: trimmed(entry?.promptTemplate ?? entry?.prompt),
  })).filter((entry) => entry.id && entry.promptTemplate);
}

function macroText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(macroText).filter(Boolean).join(', ');
  return JSON.stringify(value);
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderTemplateMacros(template, settings, values = {}) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, path) => {
    if (Object.hasOwn(values, path)) return escapeXml(macroText(values[path]));
    let current = settings;
    for (const part of path.split('.')) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return match;
      current = current[part];
    }
    return escapeXml(macroText(current));
  });
}

export function resolveIllustratorTemplate(chatMetadata, agent, manifest) {
  const settings = {
    ...record(manifest?.defaultSettings),
    ...record(agent?.settings),
  };
  const base = trimmed(agent?.promptTemplate) || trimmed(manifest?.defaultPromptTemplate);
  const options = [
    ...templateOptions(manifest?.promptTemplates),
    ...templateOptions(settings.promptTemplates),
  ];
  const selected = templateId(record(chatMetadata.agentPromptTemplateIds).illustrator)
    || templateId(settings.defaultPromptTemplateId)
    || 'default';
  if (selected === 'default') return base;
  return options.findLast((entry) => entry.id === selected)?.promptTemplate || base;
}

export function parseGeneration(row) {
  const generation = record(row?.generation);
  if (generation.version !== 1) return {
    prompt: trimmed(row?.prompt),
    negativePrompt: '',
    connectionId: '',
  };
  return {
    prompt: trimmed(generation.prompt) || trimmed(row?.prompt),
    negativePrompt: typeof generation.negativePrompt === 'string' ? generation.negativePrompt : '',
    connectionId: trimmed(generation.connectionId),
  };
}

export function galleryPath(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

export function findImageByUrl(images, url) {
  const path = galleryPath(url);
  return Array.isArray(images) ? images.find((image) => galleryPath(image?.url) === path) || null : null;
}

function imageAttachments(value, output, depth = 0) {
  if (depth > 7) return;
  if (Array.isArray(value)) {
    for (const item of value) imageAttachments(item, output, depth + 1);
    return;
  }
  const item = record(value);
  if (item.type === 'image' && trimmed(item.galleryId)) output.push(item);
  for (const child of Object.values(item)) {
    if (child && typeof child === 'object') imageAttachments(child, output, depth + 1);
  }
}

export function findIllustratorMessage(messages, imageId, mode = 'roleplay') {
  const filenamePattern = mode === 'conversation' ? /^selfie_.+\.[a-z0-9]+$/i : /^illustration_\d+\.[a-z0-9]+$/i;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' && message?.role !== 'narrator') continue;
    const attachments = [];
    imageAttachments(message?.extra, attachments);
    imageAttachments(message?.attachments, attachments);
    if (attachments.some((item) =>
      item.galleryId === imageId && filenamePattern.test(trimmed(item.filename))
    )) return message;
  }
  return null;
}

export function findSelfieCharacterName(message, imageId) {
  const attachments = [];
  imageAttachments(message?.extra, attachments);
  imageAttachments(message?.attachments, attachments);
  return trimmed(attachments.find((item) => item.galleryId === imageId && /^selfie_.+\.[a-z0-9]+$/i.test(trimmed(item.filename)))?.characterName);
}

export function resolveConversationSelfieTemplate(metadata, promptOverride, character, characterName) {
  const data = record(character?.data);
  const extensions = record(data.extensions);
  const appearance = trimmed(extensions.appearance) || trimmed(data.appearance) || trimmed(data.description)
    || trimmed(character?.appearance);
  const imageAppearance = extensions.imageAppearanceEnabled === true ? trimmed(extensions.imageAppearance) : '';
  const name = trimmed(characterName) || trimmed(data.name) || trimmed(character?.name) || 'the pictured character';
  const personality = trimmed(data.personality);
  const characterImageInstructions = trimmed(extensions.conversationImageInstructions);
  const positive = trimmed(metadata.selfiePositivePrompt)
    || (Array.isArray(metadata.selfieTags) ? metadata.selfieTags.map(trimmed).filter(Boolean).join(', ') : '');
  const values = {
    appearance, imageAppearance, charName: name, personality, characterImageInstructions,
    selfieTagsBlock: positive ? `\n\nAlways include these tags/modifiers in the prompt: ${positive}` : '',
  };
  const custom = trimmed(metadata.selfiePrompt)
    || (promptOverride?.override?.enabled === true ? trimmed(promptOverride.override.template) : '');
  if (custom) {
    if (imageAppearance && !custom.includes('${imageAppearance}')) values.appearance = imageAppearance;
    return custom.replace(/\$\{(appearance|imageAppearance|charName|personality|characterImageInstructions|selfieTagsBlock)\}/g,
      (_match, key) => values[key]);
  }
  return [
    'You are an image prompt generator. Create a concise, detailed image generation prompt for a selfie photo.',
    appearance ? `The character's appearance: ${appearance}` : '',
    imageAppearance ? `Image appearance override — include exactly as written: ${imageAppearance}. Preserve every tag and identifier verbatim.` : '',
    `Character name: ${name}`,
    personality ? `Character personality and traits: ${personality}` : '',
    characterImageInstructions ? `Character-specific image instructions: ${characterImageInstructions}` : '',
    'Describe physical appearance, clothing, expression and selfie angle, setting, lighting, and mood. Infer art style from the character.',
    positive ? `Always include these tags/modifiers in the prompt: ${positive}` : '',
  ].filter(Boolean).join('\n');
}

export function resolvePromptConfiguration({ chat, agent, manifest, connections, selectedImageConnectionId, uiState, selfiePromptOverride, selfieCharacter, selfieCharacterName }) {
  if (!['conversation', 'roleplay', 'game'].includes(chat?.mode)) throw new Error('This is not a supported chat mode.');
  const metadata = record(chat.metadata);
  const settings = { ...record(manifest?.defaultSettings), ...record(agent?.settings) };
  const promptConnectionId = trimmed(metadata.illustratorPromptConnectionId) || trimmed(chat.connectionId);
  if (!promptConnectionId) throw new Error('Choose a text connection for the Illustrator Prompt Model.');
  const connectionList = Array.isArray(connections) ? connections : [];
  const promptConnection = connectionList.find((item) => item.id === promptConnectionId);
  // Virtual connections (including Marinara's built-in local model) may not
  // appear in /api/connections. The generation API validates their IDs.
  if (promptConnection && ['image_generation', 'video_generation'].includes(promptConnection.provider)) {
    throw new Error('The Illustrator Prompt Model connection is missing or is not a text connection.');
  }
  const imageConnectionId = trimmed(selectedImageConnectionId)
    || trimmed(chat.mode === 'game' ? metadata.gameImageConnectionId
      : chat.mode === 'conversation' ? metadata.imageGenConnectionId : metadata.illustratorImageConnectionId)
    || trimmed(settings.imageConnectionId);
  const imageConnection = connectionList.find((item) => item.id === imageConnectionId) || null;
  const profiles = record(uiState?.imageStyleProfiles);
  const defaultParameters = record(imageConnection?.defaultParameters);
  const connectionDefaults = record(defaultParameters.imageGeneration);
  const styleId = trimmed(record(metadata.gameSetupConfig).imageStyleProfileId)
    || trimmed(metadata.imageStyleProfileId)
    || trimmed(connectionDefaults.styleProfileId)
    || trimmed(profiles.defaultProfileId);
  const style = Array.isArray(profiles.profiles)
    ? profiles.profiles.find((item) => item.id === styleId)
    : null;
  const template = chat.mode === 'conversation'
    ? resolveConversationSelfieTemplate(metadata, selfiePromptOverride, selfieCharacter, selfieCharacterName)
    : resolveIllustratorTemplate(metadata, agent, manifest);
  if (!template) throw new Error('The installed Illustrator has no readable prompt template.');
  return {
    promptConnectionId,
    imageConnectionId,
    template,
    styleInstruction: trimmed(style?.styleText),
    imagePromptInstructions: trimmed(imageConnection?.imagePromptInstructions),
    negativePromptInstruction: chat.mode === 'conversation' ? trimmed(metadata.selfieNegativePrompt) : '',
    contextSize: Math.max(0, Math.min(30, Number(settings.contextSize) || 12)),
    maxTokens: Math.max(512, Math.min(12000, Number(settings.maxTokens) || 4096)),
    settings,
  };
}

export function buildPromptMessages({ configuration, original, guidance, messages, sourceMessageId, characters = [], persona = null, chatId = '' }) {
  const history = Array.isArray(messages) ? messages : [];
  const sourceIndex = history.findIndex((message) => message?.id === sourceMessageId);
  const eligible = sourceIndex >= 0 ? history.slice(0, sourceIndex + 1) : [];
  const names = characters.map((character) => trimmed(character?.name)).filter(Boolean);
  const lastUser = [...eligible].reverse().find((message) => message?.role === 'user');
  const template = renderTemplateMacros(configuration.template, record(configuration.settings), {
    user: trimmed(persona?.name) || 'User',
    char: names.join(', ') || 'Assistant',
    chatId,
    lastInput: trimmed(lastUser?.content),
  });
  const characterContext = characters.map((character) => {
    const name = trimmed(character?.name);
    const appearance = trimmed(character?.appearance);
    return name ? `${name}${appearance ? ` — appearance: ${appearance.slice(0, 2500)}` : ''}` : '';
  }).filter(Boolean).join('\n');
  const system = [
    'You are the Illustrator prompt writer editing a saved image request.',
    '<selected_illustrator_prompt_mode>',
    template,
    '</selected_illustrator_prompt_mode>',
    'Preserve the selected visual format, composition rules, and applicable character guidance. Edit the saved prompt instead of choosing a new scene.',
    configuration.styleInstruction ? `Image Style instruction: ${configuration.styleInstruction}` : '',
    configuration.imagePromptInstructions ? `Image connection prompt instructions: ${configuration.imagePromptInstructions}` : '',
    configuration.negativePromptInstruction ? `Conversation selfie negative prompt guidance: ${configuration.negativePromptInstruction}` : '',
    characterContext ? `Characters in this chat:\n${characterContext}` : '',
    trimmed(persona?.appearance) ? `User persona appearance: ${trimmed(persona.appearance).slice(0, 2500)}` : '',
    'Keep unaffected details and exclusions. Do not copy the guidance verbatim into the image prompt.',
    'The selected Illustrator instructions above govern the image prompt itself. For this editing request, use the output format below instead of any response schema in those instructions. Return exactly these three markers, with the complete revised image prompt and negative prompt between them. The image prompt may itself contain JSON; keep that JSON as ordinary prompt text without escaping it for an outer JSON object. Do not add code fences or commentary:',
    '[[MARINARA_PROMPT]]\n<revised image prompt>\n[[MARINARA_NEGATIVE_PROMPT]]\n<revised negative prompt, or empty>\n[[MARINARA_END]]',
  ].filter(Boolean).join('\n\n');
  const context = eligible.slice(-configuration.contextSize).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: trimmed(message.content).slice(0, 12000),
  })).filter((message) => message.content);
  const instruction = [
    '<saved_image_request>',
    `Original Prompt:\n${original.prompt}`,
    `Original Negative prompt:\n${original.negativePrompt}`,
    '</saved_image_request>',
    '<ai_guidance>',
    trimmed(guidance) || 'Create a faithful alternate wording while preserving the scene and important visual details.',
    '</ai_guidance>',
    'Revise the original Prompt and Negative prompt according to AI guidance. Return both fields using the three markers specified above.',
  ].join('\n\n');
  return [{ role: 'system', content: system }, ...context, { role: 'user', content: instruction }];
}

export function parsePromptResult(content) {
  if (typeof content !== 'string') throw new Error('The prompt model returned no text.');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    const tagged = cleaned.match(/^\[\[MARINARA_PROMPT\]\]\s*([\s\S]*?)\s*\[\[MARINARA_NEGATIVE_PROMPT\]\]\s*([\s\S]*?)\s*\[\[MARINARA_END\]\]$/);
    if (!tagged) throw new Error('The prompt model did not return two prompt fields.');
    result = { prompt: tagged[1], negativePrompt: tagged[2] };
  }
  const prompt = trimmed(result?.prompt);
  const negativePrompt = result?.negativePrompt;
  if (!prompt || prompt.length > 200000 || typeof negativePrompt !== 'string' || negativePrompt.length > 200000) {
    throw new Error('The prompt model returned incomplete or oversized prompt fields.');
  }
  return { prompt, negativePrompt };
}
