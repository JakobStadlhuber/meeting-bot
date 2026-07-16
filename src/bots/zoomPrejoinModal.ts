import type { Frame, Page } from 'playwright';

type ZoomPrejoinRoot = Frame | Page;

const OPTIONAL_MEDIA_PROMPT = /Do you want people to see you in the meeting\?/i;
const CONTINUE_WITHOUT_MEDIA = /^(?:Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren)$/i;

export const isZoomOptionalMediaPromptText = (text?: string | null): boolean =>
  OPTIONAL_MEDIA_PROMPT.test(text ?? '')
  && /microphone and camera/i.test(text ?? '')
  && /Continue without microphone and camera/i.test(text ?? '');

export async function dismissZoomOptionalMediaPrompt(
  root: ZoomPrejoinRoot,
  timeout = 2_500,
): Promise<boolean> {
  const prompt = root
    .locator('.ReactModal__Overlay.ReactModal__Overlay--after-open')
    .filter({ hasText: OPTIONAL_MEDIA_PROMPT })
    .last();

  if (!await prompt.isVisible({ timeout }).catch(() => false)) return false;
  if (!isZoomOptionalMediaPromptText(await prompt.innerText().catch(() => ''))) return false;

  const continueWithoutMedia = prompt
    .getByRole('button', { name: CONTINUE_WITHOUT_MEDIA })
    .first();
  if (!await continueWithoutMedia.isVisible({ timeout: 1_000 }).catch(() => false)) return false;

  await continueWithoutMedia.click();
  await prompt.waitFor({ state: 'hidden', timeout: 5_000 });
  return true;
}
