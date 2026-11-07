# Image Prompt Regeneration

Image Prompt Regeneration is an external extension for Marinara Engine. It adds AI prompt editing to Marinara's **Regenerate image** dialog, so you can describe a change to an existing illustration or selfie and generate another version of it. You can review the revised prompt before making an image, or revise the prompt and generate the image in one step.

It works with Illustrator images in Roleplay and Game chats and selfies in Conversation chats. The image is still generated through Marinara's normal image workflow.

## Before you install

- You need a Marinara Engine installation that supports external extensions. This extension targets the regeneration dialog in Marinara v2.5.2 and earlier; later UI changes may affect it.
- Install and configure Marinara's **Illustrator** agent. Configure a text **Illustrator Prompt Model** connection, or a main chat text connection that it can use, and an image generation connection for the chat.

## Install

1. Build `image-regen.zip` using the commands below. Once a release is published, you can instead download the ZIP from [GitHub Releases](https://github.com/Elo-Ven/ME-image-regen/releases).
2. In Marinara Engine's `.env`, set `ENABLE_EXTERNAL_EXTENSIONS=true` and restart Marinara if it is running.
3. In Marinara, open **Settings → Advanced → Danger Zone** and enable **Allow third-party extension imports**.
4. Open **Settings → Addons → External Extensions** and import the ZIP as an **Extension File**.
5. Review the extension and its **Full page access** request, then choose **Review and Run**.

Full page access lets the extension add controls inside Marinara's existing dialog. Its prompt requests use Marinara's own APIs; it does not connect to ComfyUI directly.

## Use it

1. Open an Illustrator image from a message or the chat Gallery, then choose **Regenerate image**. For Conversation chats, open a selfie instead.
2. In **AI guidance**, describe the change you want. For example: `Keep the character and pose, but change the setting to a rainy street at night.` You can leave this blank to request a faithful alternate wording of the saved prompt.
3. Choose what to do next:

    | Control               | What it does                                                                                                                               |
    | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
    | **Generate Prompt**   | Revises **Prompt** and **Negative prompt** without generating an image. Review or edit the fields, then use **Generate image** when ready. |
    | **Generate**          | Revises both prompt fields, then starts Marinara's normal image generation.                                                                |
    | **Generate image**    | Uses the prompt fields currently shown in the dialog, without asking the prompt model to revise them.                                      |
    | **Reset to original** | Restores the saved value of the adjacent prompt field. Each field has its own reset button.                                                |

The new gallery image saves the prompts submitted for that generation. If you open **Regenerate image** on the new image later, those prompts are its originals. **AI guidance** is temporary and is not saved with the image.

## Supported images and limitations

The extra controls appear for Roleplay and Game illustrations attached to messages, Conversation selfies attached to messages, and Conversation gallery images with a saved generation record. They do not appear for unrelated images or images the extension cannot identify. For older attached images without a complete saved generation record, the visible gallery prompt is used as the original **Prompt** and the original **Negative prompt** is empty.

The extension uses the saved image request, relevant chat context, Illustrator or selfie instructions, and the selected image style to ask the chat's text Prompt Model for revised prompts. It reconstructs this context from data Marinara exposes, so its wording may differ from Marinara's internal Illustrator prompt writer. Marinara handles image generation and replacement.

## Troubleshooting

- **No extra controls:** Check that the extension is enabled and that you opened **Regenerate image** for one of the supported images above. A Marinara UI update may also require an extension update.
- **Prompt generation fails:** Check that the Illustrator agent is installed and that the chat has an available text Prompt Model connection. The built-in local Prompt Model is supported. The error appears below **AI guidance**.
- **Image generation fails:** Check Marinara's normal image generation settings. Image errors appear below **AI guidance** and through Marinara's notification.

## Build from source (optional)

If you prefer to build the extension yourself, install Node.js 20 or newer, then run these commands in the project folder:

```sh
npm ci
npm run build
```

Import `dist/image-regen.zip` as an **Extension File**, or `dist/package/` as an **Extension Folder**. The ZIP contains `manifest.json`, `extension.js`, and `extension.css` at its root.

For contributors, `npm test` runs the automated tests. They cover the dialog and mocked Marinara APIs; a live Marinara installation is needed to check the actual import and UI.

## Author

[Elo-Ven](https://github.com/Elo-Ven).
