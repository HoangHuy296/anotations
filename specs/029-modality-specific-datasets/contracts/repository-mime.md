# Repository import MIME contract

Scope: files mirrored by the private worker from a repository (`processImportDataset`). Direct and local-folder uploads follow `premedia-verification-a2.md` and
`apps/web/src/lib/upload-verification.ts`; this contract does not change them and does not touch the sealed namespace (`verified-uploads/`).

## Rule

The stored object Content-Type and `Asset.mimeType` are what the **bytes** prove. The file extension only decides which files are import candidates and which
label the object carries for the few seconds between upload and verification. An allowlisted extension type is never evidence of the subtype.

1. The worker uploads the object (key namespace and cleanup unchanged) with an upload-time label: the extension-derived type if it is one of the eleven mapped
   values (`REPOSITORY_OBJECT_CONTENT_TYPES`), otherwise `application/octet-stream`.
2. `verifyRepositoryObject` classifies the stored bytes (bounded 64 KiB prefix; bounded `ffprobe` for containers) and returns `{ modality, mimeType }`.
3. A modality different from the Dataset's modality rejects the item (`ASSET_MODALITY_MISMATCH`), removes the unpublished object and writes nothing.
4. Otherwise, if the verified type differs from the upload-time label, the object's Content-Type is replaced by a server-side metadata-replace self-copy
   (`correctRepositoryObjectContentType`: allowlisted types or `application/octet-stream` only, never the sealed namespace), and the Asset is created with
   `mimeType` = the verified type.

## Verified types

| Evidence | Modality | Verified MIME |
| --- | --- | --- |
| PNG signature + IHDR with non-zero size | IMAGE | `image/png` |
| JPEG signature | IMAGE | `image/jpeg` |
| `RIFF…WEBP` | IMAGE | `image/webp` |
| `RIFF…WAVE` | AUDIO | `audio/wav` |
| ID3 tag or MPEG frame sync | AUDIO | `audio/mpeg` |
| Valid UTF-8, no control characters | TEXT | `text/plain` (csv / json are declarations the bytes cannot prove; same rule as direct upload) |
| ffprobe format `mov,mp4,m4a,3gp,3g2,mj2` with a video stream | VIDEO | `video/mp4` |
| ffprobe format `matroska,webm` with a video stream | VIDEO | `video/webm` |
| ffprobe format `ogg` / `mp3` / `wav`, audio only | AUDIO | `audio/ogg` / `audio/mpeg` / `audio/wav` |
| Any other container / stream combination that classifies | its modality | `application/octet-stream` (unverified subtype) |
| Unparseable probe output / data-only / subtitle-only / no streams | — | refused (`SOURCE_CONTENT_UNVERIFIED` / `SOURCE_CONTENT_UNSUPPORTED`) |

## Evidence (disposable stack, real Gitea → worker → PostgreSQL → MinIO)

Before the correction, subtype followed the name: PNG bytes named `.jpg` → `image/jpeg`; WebM named `.mp4` → `video/mp4`; MP4 named `.webm` → `video/webm`; WAV named
`.mp3` → `audio/mpeg`; MP3 named `.ogg` → `audio/ogg`; broken JSON named `.json` → `application/json`.

After the correction every case stores the verified type in both the object and the Asset (`png→.jpg` = `image/png`, `webm→.mp4` = `video/webm`,
`mp4→.webm` = `video/mp4`, `wav→.mp3` = `audio/wav`, `mp3→.ogg` = `audio/mpeg`, `csv`/broken `json`/`txt` = `text/plain`). Text bytes named `.mp4` into a VIDEO Dataset and
PNG bytes named `.txt` into a TEXT Dataset are rejected with no Asset and no object left in storage.

## Limitations (recorded, not hidden)

- Assets imported before this change keep their extension-derived `mimeType`; nothing is rewritten retroactively.
- csv / json / txt subtypes cannot be proven from bytes; they are stored as `text/plain`.
- A VIDEO or AUDIO file in a container outside the table above is still published (its modality is proven) but as `application/octet-stream`.
- Files with an extension outside the importer's mapping are still candidates: they are imported if their bytes classify into the Dataset's modality, and receive the
  verified type. Narrowing the candidate set is a separate product decision.
- Repository imports use this byte classification, not the A2.4 sealed `MediaVerification` path; nothing here changes A2.4 behavior.
