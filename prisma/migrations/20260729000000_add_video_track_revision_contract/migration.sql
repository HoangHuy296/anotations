-- Phase 019: revision authority for VideoObjectTrack and safe keyframe identity.
-- The audited controlled database contained zero VideoObjectTrack rows, so
-- defaults are deterministic and no data rewrite is required.
CREATE TYPE "VideoInterpolationMode" AS ENUM ('NONE', 'LINEAR');

ALTER TABLE "VideoObjectTrack"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "annotationType" "AnnotationType" NOT NULL DEFAULT 'BOUNDING_BOX',
  ADD COLUMN "interpolationMode" "VideoInterpolationMode" NOT NULL DEFAULT 'LINEAR';

CREATE UNIQUE INDEX "Annotation_video_keyframe_track_timestamp_key"
ON "Annotation" ("trackId", "timestampMs")
WHERE "modality" = 'VIDEO'
  AND "trackId" IS NOT NULL
  AND "timestampMs" IS NOT NULL
  AND "isKeyframe" = true
  AND "isInterpolated" = false;
