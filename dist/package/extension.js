(() => {
  // src/core.mjs
  function record(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  function trimmed(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function templateId(value) {
    return trimmed(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/(^-|-$)/g, "");
  }
  function templateOptions(value) {
    const entries = Array.isArray(value) ? value : Object.entries(record(value)).map(([id, option]) => ({ ...record(option), id }));
    return entries.map((entry) => ({
      id: templateId(entry?.id),
      promptTemplate: trimmed(entry?.promptTemplate ?? entry?.prompt)
    })).filter((entry) => entry.id && entry.promptTemplate);
  }
  function macroText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(macroText).filter(Boolean).join(", ");
    return JSON.stringify(value);
  }
  function escapeXml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function renderTemplateMacros(template, settings, values = {}) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, path) => {
      if (Object.hasOwn(values, path)) return escapeXml(macroText(values[path]));
      let current = settings;
      for (const part of path.split(".")) {
        if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return match;
        current = current[part];
      }
      return escapeXml(macroText(current));
    });
  }
  function resolveIllustratorTemplate(chatMetadata, agent, manifest) {
    const settings = {
      ...record(manifest?.defaultSettings),
      ...record(agent?.settings)
    };
    const base = trimmed(agent?.promptTemplate) || trimmed(manifest?.defaultPromptTemplate);
    const options = [
      ...templateOptions(manifest?.promptTemplates),
      ...templateOptions(settings.promptTemplates)
    ];
    const selected = templateId(record(chatMetadata.agentPromptTemplateIds).illustrator) || templateId(settings.defaultPromptTemplateId) || "default";
    if (selected === "default") return base;
    return options.findLast((entry) => entry.id === selected)?.promptTemplate || base;
  }
  function parseGeneration(row) {
    const generation = record(row?.generation);
    if (generation.version !== 1) return {
      prompt: trimmed(row?.prompt),
      negativePrompt: "",
      connectionId: ""
    };
    return {
      prompt: trimmed(generation.prompt) || trimmed(row?.prompt),
      negativePrompt: typeof generation.negativePrompt === "string" ? generation.negativePrompt : "",
      connectionId: trimmed(generation.connectionId)
    };
  }
  function galleryPath(url) {
    try {
      return new URL(url, "http://localhost").pathname;
    } catch {
      return "";
    }
  }
  function findImageByUrl(images, url) {
    const path = galleryPath(url);
    return Array.isArray(images) ? images.find((image) => galleryPath(image?.url) === path) || null : null;
  }
  function imageAttachments(value, output, depth = 0) {
    if (depth > 7) return;
    if (Array.isArray(value)) {
      for (const item2 of value) imageAttachments(item2, output, depth + 1);
      return;
    }
    const item = record(value);
    if (item.type === "image" && trimmed(item.galleryId)) output.push(item);
    for (const child of Object.values(item)) {
      if (child && typeof child === "object") imageAttachments(child, output, depth + 1);
    }
  }
  function findIllustratorMessage(messages, imageId, mode = "roleplay") {
    const filenamePattern = mode === "conversation" ? /^selfie_.+\.[a-z0-9]+$/i : /^illustration_\d+\.[a-z0-9]+$/i;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== "assistant" && message?.role !== "narrator") continue;
      const attachments = [];
      imageAttachments(message?.extra, attachments);
      imageAttachments(message?.attachments, attachments);
      if (attachments.some(
        (item) => item.galleryId === imageId && filenamePattern.test(trimmed(item.filename))
      )) return message;
    }
    return null;
  }
  function findSelfieCharacterName(message, imageId) {
    const attachments = [];
    imageAttachments(message?.extra, attachments);
    imageAttachments(message?.attachments, attachments);
    return trimmed(attachments.find((item) => item.galleryId === imageId && /^selfie_.+\.[a-z0-9]+$/i.test(trimmed(item.filename)))?.characterName);
  }
  function resolveConversationSelfieTemplate(metadata, promptOverride, character, characterName) {
    const data = record(character?.data);
    const extensions = record(data.extensions);
    const appearance = trimmed(extensions.appearance) || trimmed(data.appearance) || trimmed(data.description) || trimmed(character?.appearance);
    const imageAppearance = extensions.imageAppearanceEnabled === true ? trimmed(extensions.imageAppearance) : "";
    const name = trimmed(characterName) || trimmed(data.name) || trimmed(character?.name) || "the pictured character";
    const personality = trimmed(data.personality);
    const characterImageInstructions = trimmed(extensions.conversationImageInstructions);
    const positive = trimmed(metadata.selfiePositivePrompt) || (Array.isArray(metadata.selfieTags) ? metadata.selfieTags.map(trimmed).filter(Boolean).join(", ") : "");
    const values = {
      appearance,
      imageAppearance,
      charName: name,
      personality,
      characterImageInstructions,
      selfieTagsBlock: positive ? `

Always include these tags/modifiers in the prompt: ${positive}` : ""
    };
    const custom = trimmed(metadata.selfiePrompt) || (promptOverride?.override?.enabled === true ? trimmed(promptOverride.override.template) : "");
    if (custom) {
      if (imageAppearance && !custom.includes("${imageAppearance}")) values.appearance = imageAppearance;
      return custom.replace(
        /\$\{(appearance|imageAppearance|charName|personality|characterImageInstructions|selfieTagsBlock)\}/g,
        (_match, key) => values[key]
      );
    }
    return [
      "You are an image prompt generator. Create a concise, detailed image generation prompt for a selfie photo.",
      appearance ? `The character's appearance: ${appearance}` : "",
      imageAppearance ? `Image appearance override \u2014 include exactly as written: ${imageAppearance}. Preserve every tag and identifier verbatim.` : "",
      `Character name: ${name}`,
      personality ? `Character personality and traits: ${personality}` : "",
      characterImageInstructions ? `Character-specific image instructions: ${characterImageInstructions}` : "",
      "Describe physical appearance, clothing, expression and selfie angle, setting, lighting, and mood. Infer art style from the character.",
      positive ? `Always include these tags/modifiers in the prompt: ${positive}` : ""
    ].filter(Boolean).join("\n");
  }
  function resolvePromptConfiguration({ chat, agent, manifest, connections, selectedImageConnectionId, uiState, selfiePromptOverride, selfieCharacter, selfieCharacterName }) {
    if (!["conversation", "roleplay", "game"].includes(chat?.mode)) throw new Error("This is not a supported chat mode.");
    const metadata = record(chat.metadata);
    const settings = { ...record(manifest?.defaultSettings), ...record(agent?.settings) };
    const promptConnectionId = trimmed(metadata.illustratorPromptConnectionId) || trimmed(chat.connectionId);
    if (!promptConnectionId) throw new Error("Choose a text connection for the Illustrator Prompt Model.");
    const connectionList = Array.isArray(connections) ? connections : [];
    const promptConnection = connectionList.find((item) => item.id === promptConnectionId);
    if (promptConnection && ["image_generation", "video_generation"].includes(promptConnection.provider)) {
      throw new Error("The Illustrator Prompt Model connection is missing or is not a text connection.");
    }
    const imageConnectionId = trimmed(selectedImageConnectionId) || trimmed(chat.mode === "game" ? metadata.gameImageConnectionId : chat.mode === "conversation" ? metadata.imageGenConnectionId : metadata.illustratorImageConnectionId) || trimmed(settings.imageConnectionId);
    const imageConnection = connectionList.find((item) => item.id === imageConnectionId) || null;
    const profiles = record(uiState?.imageStyleProfiles);
    const defaultParameters = record(imageConnection?.defaultParameters);
    const connectionDefaults = record(defaultParameters.imageGeneration);
    const styleId = trimmed(record(metadata.gameSetupConfig).imageStyleProfileId) || trimmed(metadata.imageStyleProfileId) || trimmed(connectionDefaults.styleProfileId) || trimmed(profiles.defaultProfileId);
    const style = Array.isArray(profiles.profiles) ? profiles.profiles.find((item) => item.id === styleId) : null;
    const template = chat.mode === "conversation" ? resolveConversationSelfieTemplate(metadata, selfiePromptOverride, selfieCharacter, selfieCharacterName) : resolveIllustratorTemplate(metadata, agent, manifest);
    if (!template) throw new Error("The installed Illustrator has no readable prompt template.");
    return {
      promptConnectionId,
      imageConnectionId,
      template,
      styleInstruction: trimmed(style?.styleText),
      imagePromptInstructions: trimmed(imageConnection?.imagePromptInstructions),
      negativePromptInstruction: chat.mode === "conversation" ? trimmed(metadata.selfieNegativePrompt) : "",
      contextSize: Math.max(0, Math.min(30, Number(settings.contextSize) || 12)),
      maxTokens: Math.max(512, Math.min(12e3, Number(settings.maxTokens) || 4096)),
      settings
    };
  }
  function buildPromptMessages({ configuration, original, guidance, messages, sourceMessageId, characters = [], persona = null, chatId = "" }) {
    const history = Array.isArray(messages) ? messages : [];
    const sourceIndex = history.findIndex((message) => message?.id === sourceMessageId);
    const eligible = sourceIndex >= 0 ? history.slice(0, sourceIndex + 1) : [];
    const names = characters.map((character) => trimmed(character?.name)).filter(Boolean);
    const lastUser = [...eligible].reverse().find((message) => message?.role === "user");
    const template = renderTemplateMacros(configuration.template, record(configuration.settings), {
      user: trimmed(persona?.name) || "User",
      char: names.join(", ") || "Assistant",
      chatId,
      lastInput: trimmed(lastUser?.content)
    });
    const characterContext = characters.map((character) => {
      const name = trimmed(character?.name);
      const appearance = trimmed(character?.appearance);
      return name ? `${name}${appearance ? ` \u2014 appearance: ${appearance.slice(0, 2500)}` : ""}` : "";
    }).filter(Boolean).join("\n");
    const system = [
      "You are the Illustrator prompt writer editing a saved image request.",
      "<selected_illustrator_prompt_mode>",
      template,
      "</selected_illustrator_prompt_mode>",
      "Preserve the selected visual format, composition rules, and applicable character guidance. Edit the saved prompt instead of choosing a new scene.",
      configuration.styleInstruction ? `Image Style instruction: ${configuration.styleInstruction}` : "",
      configuration.imagePromptInstructions ? `Image connection prompt instructions: ${configuration.imagePromptInstructions}` : "",
      configuration.negativePromptInstruction ? `Conversation selfie negative prompt guidance: ${configuration.negativePromptInstruction}` : "",
      characterContext ? `Characters in this chat:
${characterContext}` : "",
      trimmed(persona?.appearance) ? `User persona appearance: ${trimmed(persona.appearance).slice(0, 2500)}` : "",
      "Keep unaffected details and exclusions. Do not copy the guidance verbatim into the image prompt.",
      "The selected Illustrator instructions above govern the image prompt itself. For this editing request, use the output format below instead of any response schema in those instructions. Return exactly these three markers, with the complete revised image prompt and negative prompt between them. The image prompt may itself contain JSON; keep that JSON as ordinary prompt text without escaping it for an outer JSON object. Do not add code fences or commentary:",
      "[[MARINARA_PROMPT]]\n<revised image prompt>\n[[MARINARA_NEGATIVE_PROMPT]]\n<revised negative prompt, or empty>\n[[MARINARA_END]]"
    ].filter(Boolean).join("\n\n");
    const context = eligible.slice(-configuration.contextSize).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: trimmed(message.content).slice(0, 12e3)
    })).filter((message) => message.content);
    const instruction = [
      "<saved_image_request>",
      `Original Prompt:
${original.prompt}`,
      `Original Negative prompt:
${original.negativePrompt}`,
      "</saved_image_request>",
      "<ai_guidance>",
      trimmed(guidance) || "Create a faithful alternate wording while preserving the scene and important visual details.",
      "</ai_guidance>",
      "Revise the original Prompt and Negative prompt according to AI guidance. Return both fields using the three markers specified above."
    ].join("\n\n");
    return [{ role: "system", content: system }, ...context, { role: "user", content: instruction }];
  }
  function parsePromptResult(content) {
    if (typeof content !== "string") throw new Error("The prompt model returned no text.");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      const tagged = cleaned.match(/^\[\[MARINARA_PROMPT\]\]\s*([\s\S]*?)\s*\[\[MARINARA_NEGATIVE_PROMPT\]\]\s*([\s\S]*?)\s*\[\[MARINARA_END\]\]$/);
      if (!tagged) throw new Error("The prompt model did not return two prompt fields.");
      result = { prompt: tagged[1], negativePrompt: tagged[2] };
    }
    const prompt = trimmed(result?.prompt);
    const negativePrompt = result?.negativePrompt;
    if (!prompt || prompt.length > 2e5 || typeof negativePrompt !== "string" || negativePrompt.length > 2e5) {
      throw new Error("The prompt model returned incomplete or oversized prompt fields.");
    }
    return { prompt, negativePrompt };
  }

  // src/client.js
  var ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  var UI_STORAGE_KEYS = ["marinara-engine-ui:host", "marinara-engine-ui"];
  var active = null;
  var scanQueued = false;
  var stopped = false;
  async function request(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...options.body ? { "Content-Type": "application/json", "x-marinara-csrf": "1" } : {}
      },
      ...options.body ? { body: JSON.stringify(options.body) } : {},
      signal: options.signal,
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Marinara request failed (${response.status}).`);
    return data;
  }
  function readUiState() {
    for (const key of UI_STORAGE_KEYS) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || "{}");
        if (saved?.state && typeof saved.state === "object") return saved.state;
      } catch {
      }
    }
    return {};
  }
  function elementsForDialog(dialog) {
    const picture = dialog.querySelector('img[src*="/api/gallery/file/"]');
    if (!picture) return null;
    for (const connectionControl of dialog.querySelectorAll('select, button[data-connection-value][aria-haspopup="dialog"]')) {
      const connectionLabel = connectionControl.closest("label");
      const form = connectionLabel?.parentElement;
      if (!form) continue;
      const labels = [...form.children].filter((item) => item.matches?.("label"));
      const fields = labels.filter((item) => item.querySelector("textarea"));
      if (fields.length < 2) continue;
      const footer = [...form.children].findLast((item) => item.querySelectorAll?.("button").length >= 2);
      const nativeGenerate = footer?.querySelector("button:last-of-type");
      if (!footer || !nativeGenerate) continue;
      return {
        dialog,
        picture,
        form,
        connectionLabel,
        promptLabel: fields[0],
        negativeLabel: fields[1],
        prompt: fields[0].querySelector("textarea"),
        negative: fields[1].querySelector("textarea"),
        connectionControl,
        footer,
        nativeGenerate
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
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("This browser cannot update Marinara\u2019s prompt fields.");
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function status(state, message, isError = false) {
    state.status.textContent = message;
    state.status.classList.toggle("image-regen-error", isError);
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
      request("/api/agents", { signal: state.controller.signal }),
      request("/api/capability-packages/agents", { signal: state.controller.signal }),
      request("/api/connections", { signal: state.controller.signal })
    ]);
    const agent = Array.isArray(agents) ? agents.find((item) => item.type === "illustrator") : null;
    const manifest = Array.isArray(manifests) ? manifests.find((item) => item.id === "illustrator") : null;
    if (!agent || !manifest) throw new Error("Install and configure the Illustrator agent first.");
    const connectionControl = state.elements.connectionControl;
    const selectedImageConnectionId = trimmed(
      connectionControl.matches("select") ? connectionControl.value : connectionControl.dataset.connectionValue
    ) || state.original.connectionId;
    let rows = Array.isArray(connections) ? connections : [];
    if (selectedImageConnectionId) {
      const detail = await request(`/api/connections/${encodeURIComponent(selectedImageConnectionId)}`, {
        signal: state.controller.signal
      });
      rows = [...rows.filter((item) => item.id !== selectedImageConnectionId), detail];
    }
    const characterIds = Array.isArray(chat.characterIds) ? chat.characterIds.slice(0, 12) : [];
    const [characters, persona, selfiePromptOverride] = await Promise.all([
      Promise.all(characterIds.map(
        (id) => request(`/api/characters/${encodeURIComponent(id)}`, { signal: state.controller.signal }).catch(() => null)
      )),
      trimmed(chat.personaId) ? request(`/api/personas/${encodeURIComponent(chat.personaId)}`, { signal: state.controller.signal }).catch(() => null) : Promise.resolve(null),
      chat.mode === "conversation" ? request("/api/prompt-overrides/conversation.selfie", { signal: state.controller.signal }) : Promise.resolve(null)
    ]);
    const selfieCharacter = chat.mode === "conversation" ? characters.filter(Boolean).find((character) => {
      const data = record(character.data);
      return trimmed(data.name || character.name).toLowerCase() === state.selfieCharacterName.toLowerCase();
    }) || (characters.filter(Boolean).length === 1 ? characters.find(Boolean) : null) : null;
    const configuration = resolvePromptConfiguration({
      chat,
      agent,
      manifest,
      connections: rows,
      selectedImageConnectionId,
      uiState: readUiState(),
      selfiePromptOverride,
      selfieCharacter,
      selfieCharacterName: state.selfieCharacterName
    });
    const messages = buildPromptMessages({
      configuration,
      original: state.original,
      guidance: state.guidance.value,
      messages: state.messages,
      sourceMessageId: state.sourceMessage?.id,
      characters: characters.filter(Boolean),
      persona,
      chatId: chat.id
    });
    const body = {
      connectionId: configuration.promptConnectionId,
      messages,
      parameters: { temperature: 0.55, maxTokens: configuration.maxTokens },
      streaming: false
    };
    const raw = await request("/api/generate/raw", { method: "POST", body, signal: state.controller.signal });
    try {
      return parsePromptResult(raw.content);
    } catch (firstError) {
      const repair = await request("/api/generate/raw", {
        method: "POST",
        body: {
          ...body,
          messages: [
            ...messages,
            { role: "assistant", content: String(raw.content || "").slice(0, 7e3) },
            { role: "user", content: "Return exactly [[MARINARA_PROMPT]], the complete nonempty revised image prompt, [[MARINARA_NEGATIVE_PROMPT]], the revised negative prompt (which may be empty), and [[MARINARA_END]]. Keep any JSON inside the image prompt as plain text between the markers. Add no other text." }
          ]
        },
        signal: state.controller.signal
      });
      return parsePromptResult(repair.content);
    }
  }
  async function runPrompt(state, withImage) {
    if (state.busy || state.nativeGenerate.disabled || !state.elements.form.isConnected) return;
    busy(state, true);
    status(state, "Generating prompt\u2026");
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
        throw new Error("Marinara did not accept the revised prompt fields.");
      }
      if (withImage) {
        status(state, "Prompt ready. Generating image\u2026");
        busy(state, false);
        state.nativeGenerate.click();
        handedOff = true;
      } else {
        status(state, "Prompt ready. Review the fields or generate the image.");
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        if (previousValues && !handedOff && state.elements.form.isConnected) {
          setNativeText(state.elements.prompt, previousValues[0]);
          setNativeText(state.elements.negative, previousValues[1]);
        }
        status(state, error?.message || "Prompt generation failed.", true);
      }
    } finally {
      if (!state.controller.signal.aborted && state.elements.form.isConnected) busy(state, false);
    }
  }
  function makeButton(label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }
  function makeGenerateButton(label, nativeGenerate) {
    const button = makeButton(label, `${nativeGenerate.className} image-regen-action`);
    const icon = nativeGenerate.querySelector("svg");
    if (icon) button.prepend(icon.cloneNode(true));
    return button;
  }
  function mount(state) {
    const elements = state.elements;
    const nodes = [];
    const resetButtons = [];
    for (const [label, field, initial] of [
      [elements.promptLabel, elements.prompt, state.original.prompt],
      [elements.negativeLabel, elements.negative, state.original.negativePrompt]
    ]) {
      const button = makeButton("Reset to original", "image-regen-reset");
      button.setAttribute("aria-label", `Reset ${label.querySelector("span")?.textContent || "prompt"} to original`);
      button.addEventListener("click", () => setNativeText(field, initial));
      const heading = label.querySelector("span") || label;
      heading.appendChild(button);
      nodes.push(button);
      resetButtons.push(button);
    }
    const guidanceLabel = document.createElement("label");
    guidanceLabel.className = "image-regen-guidance";
    const title = document.createElement("span");
    title.textContent = "AI guidance";
    const guidance = document.createElement("textarea");
    guidance.rows = 3;
    guidance.placeholder = "Describe how to change the original prompt\u2026";
    guidance.setAttribute("aria-label", "AI guidance");
    guidanceLabel.append(title, guidance);
    elements.connectionLabel.after(guidanceLabel);
    nodes.push(guidanceLabel);
    const feedback = document.createElement("p");
    feedback.className = "image-regen-status";
    feedback.setAttribute("role", "status");
    guidanceLabel.after(feedback);
    nodes.push(feedback);
    const promptButton = makeGenerateButton("Generate Prompt", elements.nativeGenerate);
    const bothButton = makeGenerateButton("Generate", elements.nativeGenerate);
    bothButton.classList.add("image-regen-both");
    promptButton.addEventListener("click", () => void runPrompt(state, false));
    bothButton.addEventListener("click", () => void runPrompt(state, true));
    elements.nativeGenerate.before(promptButton);
    elements.nativeGenerate.after(bothButton);
    elements.nativeGenerate.classList.add("image-regen-native");
    elements.footer.classList.add("image-regen-footer");
    nodes.push(promptButton, bothButton);
    const guardNativeClick = (event) => {
      if (!state.busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    elements.nativeGenerate.addEventListener("click", guardNativeClick, true);
    const nativeStateObserver = new MutationObserver(() => {
      const nativeIcon = elements.nativeGenerate.querySelector("svg");
      for (const button of [state.promptButton, state.bothButton]) {
        button.className = `${elements.nativeGenerate.className.replace(/\bimage-regen-native\b/g, "").trim()} image-regen-action`;
        const currentIcon = button.querySelector("svg");
        if (nativeIcon) {
          if (currentIcon) currentIcon.replaceWith(nativeIcon.cloneNode(true));
          else button.prepend(nativeIcon.cloneNode(true));
        } else {
          currentIcon?.remove();
        }
      }
      state.bothButton.classList.add("image-regen-both");
      busy(state, state.busy);
    });
    nativeStateObserver.observe(elements.nativeGenerate, {
      attributes: true,
      attributeFilter: ["disabled", "class"],
      childList: true
    });
    Object.assign(state, {
      nodes,
      resetButtons,
      status: feedback,
      guidance,
      promptButton,
      bothButton,
      nativeGenerate: elements.nativeGenerate,
      disposers: [
        () => elements.nativeGenerate.removeEventListener("click", guardNativeClick, true),
        () => nativeStateObserver.disconnect(),
        () => elements.nativeGenerate.classList.remove("image-regen-native"),
        () => elements.footer.classList.remove("image-regen-footer")
      ]
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
      if (!["conversation", "roleplay", "game"].includes(chat.mode)) return;
      const messages = await request(`/api/chats/${encodeURIComponent(image.chatId)}/messages`, { signal: controller.signal });
      const sourceMessage = findIllustratorMessage(messages, image.id, chat.mode);
      const savedGeneration = record(image.generation);
      if (!sourceMessage && !(chat.mode === "conversation" && savedGeneration.version === 1 && trimmed(savedGeneration.prompt))) return;
      if (controller.signal.aborted || !elements.form.isConnected) return;
      state.image = image;
      state.messages = messages;
      state.sourceMessage = sourceMessage;
      state.selfieCharacterName = chat.mode === "conversation" ? findSelfieCharacterName(sourceMessage, image.id) : "";
      state.original = parseGeneration(image);
      mount(state);
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[Image Regen] Could not inspect the selected image:", error);
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
  var observer = new MutationObserver(queueScan);
  observer.observe(document.body, { childList: true, subtree: true });
  queueScan();
  marinara.onCleanup(() => {
    stopped = true;
    observer.disconnect();
    cleanup();
  });
})();
