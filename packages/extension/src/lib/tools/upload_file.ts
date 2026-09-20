// Tool: upload_file — programmatically attach files to <input type="file">
// via the DataTransfer API, in the content script. Zero CDP / debugger.
//
// Pipeline:
//   1. MCP caller supplies base64-encoded file payloads and
//      sends them over the bridge as `{ name, data, mimeType }`.
//   2. SW receives, routes to the correct frame's content script.
//   3. Content script (actSetFiles in actions.ts) decodes base64 → Uint8Array
//      → File, builds a DataTransfer, assigns input.files, dispatches change.
//
// Sites that strictly check event.isTrusted on file inputs may still
// reject synthetic file changes.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import type { UploadFileParams, UploadFileResult } from '../../shared/protocol'
import type { SetFilesPayload } from '../../content-scripts/protocol'

export async function uploadFile(
  tabId: number,
  params: UploadFileParams
): Promise<UploadFileResult> {
  if (!params.target.ref) throw new Error('target.ref is required')
  if (!params.files?.length) throw new Error('files must be a non-empty array')

  const { frameId, localRef } = parseRef(params.target.ref)
  const data = await sendToFrame<SetFilesPayload>(tabId, frameId, {
    op: 'set_files',
    ref: localRef,
    files: params.files
  })
  return { ok: true, count: data.count, names: data.names }
}
